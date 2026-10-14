import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import { money } from "@/lib/money";
import {
  attemptUrls,
  orderUrlFor,
  startPaymentForOrder,
} from "@/server/checkout/start";
import { type Db, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  orderItems,
  orders,
  paymentAttempts,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import {
  type Effects,
  mergeEffects,
  type ServiceResult,
  withEffects,
} from "@/server/domain/effects";
import { isUniqueViolation } from "@/server/domain/errors";
import { transition } from "@/server/domain/transition";
import { env as defaultEnv, type Env } from "@/server/env";
import { isProviderError } from "@/server/integrations/http";
import { log } from "@/server/log";
import { checkLimit } from "@/server/security/rate-limit";
import { getSetting } from "@/server/settings";
import { lockPaymentContext, otherAttemptInFlight, quoteBound } from "./apply";
import { isPendingSaleRef, pendingSaleRef } from "./providers/isracard-map";
import { providerForAttempt } from "./registry";
import {
  type CreateSaleInput,
  isHostedFieldsProvider,
  type PaySaleResult,
} from "./types";
import { finalizeForBuyer } from "./webhook";

/**
 * The card charge of our own pay page (Isracard hosted fields): one claim, one `generate-sale`,
 * one `pay-sale` per attempt, then the one `finalizeAttempt()`.
 *
 * 1. Claim transaction (artworks → order → attempt): the attempt is still PENDING with its `hf:`
 *    placeholder, the order AWAITING_PAYMENT with a live hold and a bound quote, and no other
 *    attempt of the order is in flight. The holds and `expires_at` are extended to at least
 *    `CHARGE_HOLD_MINUTES` from now, and the attempt goes PENDING → CAPTURING: the hold is kept by
 *    the expiry job, "Pay now" and "Release" are refused, and `payment_attempts_one_winner_idx`
 *    refuses a second charging attempt of the order. A second submit of the same page loses the
 *    claim and goes to the order page.
 * 2. `generate-sale` (charges nothing): its sale id replaces the placeholder. Any failure → the
 *    attempt FAILED and a new pay page (the buyer may simply try again).
 * 3. `pay-sale` with the one-time token, **never again for this attempt**: the adapter has no
 *    `capture` and never reports `requires_capture`, so finalize cannot charge either. Completed →
 *    finalize within the return budget; a 3-D Secure challenge → the buyer goes to it (the return
 *    route finalizes); a decline → FAILED and a new attempt's pay page (5 declines per hour per IP
 *    at most); a timeout or an unreadable answer → the order page "being confirmed", settled by the
 *    callback, reconcile or the daily sweep.
 *
 * The token, the card holder's ID number and the client data are passed through, never stored or
 * logged.
 */
export const CHARGE_HOLD_MINUTES = 10;

export interface ChargeInput {
  attemptId: string;
  /** One-time card token from the hosted fields (PayMe `buyer_key`). */
  buyerKey: string;
  /** Hosted fields' client data for 3-D Secure (`PayMe.clientData().hash`). */
  clientData: string | null;
  /** Israeli ID number typed by the card holder. */
  socialId: string | null;
  installments: number;
  locale: Locale;
  ipHash: string | null;
}

export type ChargeOutcome =
  /** Open this URL with a full page load: the order page, a 3-D Secure challenge or a new pay page. */
  | { kind: "navigate"; url: string }
  /** Nothing was charged and nothing changed: show the error on the pay page. */
  | { kind: "error"; code: "invalid" | "not_configured" };

type Row = {
  attempt: typeof paymentAttempts.$inferSelect;
  order: typeof orders.$inferSelect;
};

class ChargeRefused extends Error {
  constructor(public readonly code: "not_payable" | "in_flight") {
    super(code);
    this.name = "ChargeRefused";
  }
}

const NO_EFFECTS: Effects = {};

export async function chargeAttemptWithToken(
  i: ChargeInput,
  deps: { db?: Db; env?: Env } = {},
): Promise<ServiceResult<ChargeOutcome>> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const [row] = await db
    .select({ attempt: paymentAttempts, order: orders })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(eq(paymentAttempts.id, i.attemptId));
  if (row?.attempt.provider !== "ISRACARD") {
    return withEffects({ kind: "error", code: "invalid" });
  }
  const orderPage = (query: Record<string, string> = {}) =>
    orderUrlFor(row.order, i.locale, query, e);
  const navigate = (url: string, effects: Effects = NO_EFFECTS) =>
    withEffects<ChargeOutcome>({ kind: "navigate", url }, effects);

  // Already charged or charging (a second submit, a stale tab): the order page knows.
  if (
    row.attempt.status !== "PENDING" ||
    !isPendingSaleRef(row.attempt.providerRef)
  ) {
    return navigate(orderPage());
  }
  const pfa = await providerForAttempt(row.attempt, { env: e, db });
  if (pfa.kind !== "ok" || !isHostedFieldsProvider(pfa.provider)) {
    return withEffects({ kind: "error", code: "not_configured" });
  }
  const provider = pfa.provider;
  const checkout = await getSetting("checkout", db);
  const maxInstallments =
    row.order.shipCountry === "IL" && row.order.currency === "ILS"
      ? Math.max(1, checkout.maxInstallments)
      : 1;
  if (
    !Number.isInteger(i.installments) ||
    i.installments < 1 ||
    i.installments > maxInstallments
  ) {
    return withEffects({ kind: "error", code: "invalid" });
  }

  // 1. Claim.
  try {
    const claimed = await claim(db, i);
    if (!claimed) return navigate(orderPage({ payment: "capturing" }));
  } catch (error) {
    if (error instanceof ChargeRefused) {
      return navigate(orderPage({ err: error.code }));
    }
    if (isUniqueViolation(error, "payment_attempts_one_winner_idx")) {
      return navigate(orderPage({ err: "in_flight" }));
    }
    throw error;
  }

  // 2. The sale (charges nothing).
  const urls = attemptUrls(i.attemptId, "isracard", i.locale, e);
  const sale: CreateSaleInput = {
    attemptId: i.attemptId,
    amount: money(row.attempt.amountMinor, row.attempt.currency),
    productName: await productName(db, row, i.locale),
    installments: i.installments,
    locale: i.locale,
    notifyUrl: urls.notifyUrl,
    returnUrl: urls.returnUrl,
    // A failed 3-D Secure authentication comes back through the return route: "not completed".
    cancelUrl: urls.failUrl,
  };
  let saleId: string;
  try {
    saleId = (await provider.hostedFields.createSale(sale)).saleId;
  } catch (error) {
    log.warn("payments.create_sale_failed", {
      attemptId: i.attemptId,
      error: errorName(error),
    });
    await failCharge(db, i.attemptId, `CREATE:${errorCode(error)}`);
    return retry(db, e, row, i, orderPage);
  }
  const stored = await db
    .update(paymentAttempts)
    .set({ providerRef: saleId, updatedAt: new Date() })
    .where(
      and(
        eq(paymentAttempts.id, i.attemptId),
        eq(paymentAttempts.status, "CAPTURING"),
        eq(paymentAttempts.providerRef, pendingSaleRef(i.attemptId)),
      ),
    )
    .returning({ id: paymentAttempts.id });
  if (stored.length === 0) return navigate(orderPage());

  // 3. Pay, once.
  let paid: PaySaleResult;
  try {
    paid = await provider.hostedFields.paySale({
      ...sale,
      saleId,
      buyerKey: i.buyerKey,
      clientData: i.clientData,
      // Buyer details go to the live service only (spec §4.2: none to a test environment).
      buyer:
        provider.mode === "LIVE" && row.order.buyerName && row.order.buyerEmail
          ? { name: row.order.buyerName, email: row.order.buyerEmail }
          : null,
      socialId: i.socialId,
    });
  } catch (error) {
    // Unknown outcome: never charge again; the callback, reconcile or the sweep settle it.
    log.warn("payments.pay_sale_unknown", {
      attemptId: i.attemptId,
      error: errorName(error),
    });
    return navigate(orderPage({ payment: "capturing" }));
  }
  switch (paid.kind) {
    case "challenge":
      await db
        .update(paymentAttempts)
        .set({ redirectUrl: paid.redirectUrl, updatedAt: new Date() })
        .where(eq(paymentAttempts.id, i.attemptId));
      return navigate(paid.redirectUrl);
    case "declined": {
      await failCharge(db, i.attemptId, `DECLINED:${paid.code}`);
      const limit = await checkLimit("payDeclineIp", i.ipHash ?? "unknown-ip", {
        db,
      });
      if (!limit.allowed) {
        return navigate(orderPage({ payment: "failed", err: "declined" }));
      }
      return retry(db, e, row, i, orderPage);
    }
    case "completed": {
      const done = await finalizeForBuyer(i.attemptId, { db, env: e });
      return navigate(orderPage({ payment: done.outcome }), done.effects);
    }
  }
}

async function claim(db: Db, i: ChargeInput): Promise<boolean> {
  return withTx(
    async (tx) => {
      const ctx = await lockPaymentContext(tx, i.attemptId);
      const { attempt, order, locked } = ctx;
      const now = new Date();
      if (
        attempt.status !== "PENDING" ||
        !isPendingSaleRef(attempt.providerRef)
      ) {
        return false;
      }
      const holdLive =
        order.status === "AWAITING_PAYMENT" &&
        order.expiresAt !== null &&
        order.expiresAt.getTime() > now.getTime() &&
        locked.length > 0 &&
        locked.every(
          (a) =>
            a.reservedByOrderId === order.id &&
            a.reservedUntil !== null &&
            a.reservedUntil.getTime() > now.getTime(),
        );
      if (!holdLive || !quoteBound(attempt, order)) {
        throw new ChargeRefused("not_payable");
      }
      if (await otherAttemptInFlight(tx, attempt)) {
        throw new ChargeRefused("in_flight");
      }
      await tx
        .update(artworks)
        .set({
          reservedUntil: sql`greatest(${artworks.reservedUntil}, now() + make_interval(mins => ${CHARGE_HOLD_MINUTES}::int))`,
        })
        .where(
          inArray(
            artworks.id,
            locked.map((a) => a.id),
          ),
        );
      await tx
        .update(orders)
        .set({
          expiresAt: sql`greatest(${orders.expiresAt}, now() + make_interval(mins => ${CHARGE_HOLD_MINUTES}::int))`,
        })
        .where(eq(orders.id, order.id));
      await transition(
        tx,
        "attempt",
        attempt.id,
        ["PENDING"],
        "CAPTURING",
        {
          captureRequestId: randomUUID(),
          capturingSince: now,
          captureTries: 1,
          installments: i.installments,
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + 2 * 60_000),
        },
        `buyer:${order.number}`,
        { action: "payment.charge_claimed" },
      );
      return true;
    },
    { db, name: "payments.charge_claim" },
  );
}

/** CAPTURING → FAILED: nothing was charged (a refused sale or a declined card); the hold stays. */
async function failCharge(db: Db, attemptId: string, reason: string) {
  await withTx(
    async (tx) => {
      const ctx = await lockPaymentContext(tx, attemptId);
      if (ctx.attempt.status !== "CAPTURING") return;
      await transition(
        tx,
        "attempt",
        attemptId,
        ["CAPTURING"],
        "FAILED",
        {
          failureReason: reason.slice(0, 200),
          finalizedAt: new Date(),
          nextCheckAt: null,
        },
        "system",
      );
    },
    { db, name: "payments.charge_failed" },
  );
}

/** A new attempt's pay page (the hold is still live), or the order page when none can start. */
async function retry(
  db: Db,
  e: Env,
  row: Row,
  i: ChargeInput,
  orderPage: (q?: Record<string, string>) => string,
): Promise<ServiceResult<ChargeOutcome>> {
  const next = await startPaymentForOrder(
    {
      orderId: row.order.id,
      providerId: "isracard",
      locale: i.locale,
      ipHash: i.ipHash,
    },
    { db, env: e },
  );
  const effects = mergeEffects(NO_EFFECTS, next.effects);
  if (next.result.kind === "redirect") {
    const url = new URL(next.result.url);
    url.searchParams.set("declined", "1");
    return withEffects({ kind: "navigate", url: url.toString() }, effects);
  }
  return withEffects(
    { kind: "navigate", url: orderPage({ payment: "failed" }) },
    effects,
  );
}

/** "<order number> · <titles>": shown to the buyer and on PayMe's documents; no PII. */
async function productName(db: Db, row: Row, locale: Locale): Promise<string> {
  const items = await db
    .select({ he: orderItems.titleHe, en: orderItems.titleEn })
    .from(orderItems)
    .where(eq(orderItems.orderId, row.order.id));
  const titles = items.map((t) => (locale === "he" ? t.he : t.en)).join(", ");
  return `${row.order.number} · ${titles}`.slice(0, 200);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function errorCode(error: unknown): string {
  if (isProviderError(error)) {
    const code = (error as { code?: string }).code;
    return (code ?? error.name).slice(0, 60);
  }
  return errorName(error);
}
