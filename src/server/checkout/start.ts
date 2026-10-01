import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, max, type SQL, sql } from "drizzle-orm";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import type { Locale } from "@/lib/locale";
import { money } from "@/lib/money";
import { absoluteUrl, apiPaths, localePath, paths } from "@/lib/routes";
import { audit } from "@/server/audit";
import { type Db, db as defaultDb, type Tx } from "@/server/db/client";
import {
  artworks,
  type Order,
  orderItems,
  orders,
  type PaymentAttempt,
  paymentAttempts,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, isUniqueViolation } from "@/server/domain/errors";
import { newOrderNumber } from "@/server/domain/ids";
import { transition } from "@/server/domain/transition";
import { env as defaultEnv, type Env } from "@/server/env";
import { log } from "@/server/log";
import { buildProvider } from "@/server/payments/registry";
import {
  type PaymentProvider,
  PROVIDER_DB_VALUE,
  type ProviderId,
} from "@/server/payments/types";
import { hmacToken, orderAccessToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import type { CheckoutSettings } from "@/server/settings/schemas";
import { detectConversation } from "./conversation";
import { itemPriceMinor } from "./pricing";
import { getCheckoutQuote } from "./quote";
import {
  allReservable,
  checkHoldCaps,
  expireTakenOverOrders,
  HoldRefusedError,
  lockArtworks,
  lockOrder,
  orderArtworkIds,
  ordersWithAttemptInFlight,
  reserveArtworks,
  takeBuyerLocks,
} from "./reservations";
import type {
  CheckoutQuote,
  StartCheckoutInput,
  StartCheckoutResult,
} from "./types";

/**
 * `startCheckout()` (spec §5.1 step 3; frozen contract): one `withTx` per §3.5 (lock artworks →
 * advisory locks and caps → order → items → reserve → takeover expiry → attempt #1), then
 * `createCheckout` outside the transaction. `startPaymentForOrder()` is the order page "Pay"
 * (and link orders): a new attempt bound to the current `quote_version`.
 *
 * `deps.db` lets race tests run each contender on its own connection.
 */
export interface StartDeps {
  db?: Db;
  env?: Env;
}

/** Thrown inside the transaction to roll it back with a typed result. */
class StartAbort extends Error {
  constructor(public readonly result: StartCheckoutResult) {
    super("start aborted");
    this.name = "StartAbort";
  }
}

/** The same `client_request_id` committed while this transaction waited: resume that order. */
class ResumeSignal extends Error {
  constructor() {
    super("resume the existing order");
    this.name = "ResumeSignal";
  }
}

const SYSTEM_ACTOR = "system";

/** Absolute order page URL with the `?k=` access token (plus extra query parameters). */
export function orderUrlFor(
  order: Pick<Order, "id" | "number" | "accessVersion">,
  locale: Locale,
  query: Record<string, string> = {},
  e: Env = defaultEnv,
): string {
  const token = orderAccessToken(order.id, order.accessVersion);
  const path = localePath(locale, paths.order(order.number, token));
  const extra = new URLSearchParams(query).toString();
  return absoluteUrl(e.APP_URL, extra ? `${path}&${extra}` : path);
}

// ---------------------------------------------------------------- provider session

/**
 * Creates the provider session for a CREATED attempt, outside any transaction (spec §5.1 step 7):
 * error → attempt FAILED with the hold kept; success → PENDING with `provider_ref` and
 * `redirect_url` stored **before** the redirect.
 */
export async function launchAttempt(
  attempt: PaymentAttempt,
  order: Order,
  provider: PaymentProvider,
  locale: Locale,
  deps: StartDeps = {},
): Promise<{ ok: true; url: string } | { ok: false }> {
  const e = deps.env ?? defaultEnv;
  const db = deps.db ?? defaultDb;
  const items = await db
    .select({
      titleHe: orderItems.titleHe,
      titleEn: orderItems.titleEn,
      priceMinor: orderItems.priceMinor,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const checkout = await getSetting("checkout", db);
  const returnToken = hmacToken("return", attempt.id);
  const ret = (s: "success" | "failed" | "cancel") =>
    absoluteUrl(
      e.APP_URL,
      apiPaths.paymentReturn(provider.id, {
        a: attempt.id,
        r: returnToken,
        l: locale,
        s,
      }),
    );
  const notifyUrl = absoluteUrl(
    e.PUBLIC_WEBHOOK_BASE_URL,
    apiPaths.paymentWebhook(
      provider.id,
      provider.id === "cardcom"
        ? { a: attempt.id, t: hmacToken("cardcom-notify", attempt.id) }
        : {},
    ),
  );
  const shipTo =
    order.shipLine1 && order.shipCity && order.shipName
      ? {
          name: order.shipName,
          line1: order.shipLine1,
          ...(order.shipLine2 ? { line2: order.shipLine2 } : {}),
          city: order.shipCity,
          ...(order.shipRegion ? { region: order.shipRegion } : {}),
          ...(order.shipPostalCode ? { postalCode: order.shipPostalCode } : {}),
          country: order.shipCountry,
          phone: order.shipPhone ?? order.buyerPhone ?? "",
        }
      : undefined;
  try {
    const session = await provider.createCheckout({
      attemptId: attempt.id,
      attemptSeq: attempt.seq,
      orderId: order.id,
      orderNumber: order.number,
      amount: money(attempt.amountMinor, attempt.currency),
      lines: items.map((i) => ({
        name: locale === "he" ? i.titleHe : i.titleEn,
        amount: money(i.priceMinor, order.currency),
      })),
      shipping: money(order.shippingMinor, order.currency),
      insurance: money(order.insuranceMinor, order.currency),
      // No buyer PII outside live mode (the shared Cardcom test terminal, spec §4.2).
      buyer:
        provider.mode === "LIVE" && order.buyerName && order.buyerEmail
          ? {
              name: order.buyerName,
              email: order.buyerEmail,
              ...(order.buyerPhone ? { phone: order.buyerPhone } : {}),
            }
          : null,
      ...(shipTo ? { shipTo } : {}),
      locale,
      returnUrl: ret("success"),
      cancelUrl: ret("cancel"),
      failUrl: ret("failed"),
      notifyUrl,
      maxInstallments:
        order.shipCountry === "IL" && order.currency === "ILS"
          ? checkout.maxInstallments
          : 1,
      idemKey: attempt.createRequestId ?? attempt.id,
    });
    await withTx(
      (tx) =>
        transition(
          tx,
          "attempt",
          attempt.id,
          ["CREATED"],
          "PENDING",
          {
            providerRef: session.providerRef,
            redirectUrl: session.next.url,
            nextCheckAt: new Date(Date.now() + 2 * 60_000),
          },
          SYSTEM_ACTOR,
          { skipAudit: true },
        ),
      { db, name: "attempt.pending" },
    );
    return { ok: true, url: session.next.url };
  } catch (error) {
    log.warn("checkout.create_checkout_failed", {
      attemptId: attempt.id,
      provider: provider.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    await withTx(
      (tx) =>
        transition(
          tx,
          "attempt",
          attempt.id,
          ["CREATED"],
          "FAILED",
          {
            failureReason:
              error instanceof Error
                ? `create: ${error.name}`.slice(0, 200)
                : "create: error",
            finalizedAt: new Date(),
          },
          SYSTEM_ACTOR,
        ),
      { db, name: "attempt.create_failed" },
    ).catch((e2) => log.error("checkout.mark_failed_failed", {}, e2));
    return { ok: false };
  }
}

// ---------------------------------------------------------------- startCheckout

async function resumeByClientRequestId(
  db: Db,
  e: Env,
  clientRequestId: string,
  locale: Locale,
): Promise<StartCheckoutResult | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.clientRequestId, clientRequestId))
    .limit(1);
  if (!order) return null;
  const [latest] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.id))
    .orderBy(desc(paymentAttempts.seq))
    .limit(1);
  const url =
    latest?.status === "PENDING" && latest.redirectUrl
      ? latest.redirectUrl
      : orderUrlFor(order, locale, {}, e);
  return {
    kind: "redirect",
    orderId: order.id,
    orderNumber: order.number,
    accessToken: orderAccessToken(order.id, order.accessVersion),
    url,
  };
}

type OkQuote = Extract<CheckoutQuote, { kind: "ok" }>;

export async function startCheckout(
  input: StartCheckoutInput,
  deps: StartDeps = {},
): Promise<ServiceResult<StartCheckoutResult>> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;

  // Double submit: the same client_request_id resumes the existing order (spec §5.1 step 3.2).
  const resumed = await resumeByClientRequestId(
    db,
    e,
    input.clientRequestId,
    input.locale,
  );
  if (resumed) return withEffects(resumed);

  // Server re-quote: nothing is written when the total differs (step 3.3).
  const quote = await getCheckoutQuote(
    {
      slug: input.slug,
      locale: input.locale,
      country: input.country,
      method: input.method,
      currency: input.currency,
    },
    { db, env: e },
  );
  if (quote.kind === "blocked") {
    if (quote.reason === "RESERVED") {
      return withEffects({ kind: "just_reserved" });
    }
    return withEffects({ kind: "refused", code: quote.reason });
  }
  if (
    quote.shipping.method !== input.method ||
    quote.currency !== input.currency ||
    quote.country !== input.country ||
    quote.totalMinor !== input.expectedTotalMinor
  ) {
    return withEffects({ kind: "price_changed", quote });
  }
  if (!quote.providers.some((p) => p.id === input.providerId)) {
    return withEffects({ kind: "refused", code: "provider_unavailable" });
  }
  const provider = buildProvider(input.providerId, { env: e });
  if (!provider) {
    return withEffects({ kind: "refused", code: "provider_unavailable" });
  }
  if (input.country !== "IL" && !input.consents.dutiesNoticeVersion) {
    return withEffects({ kind: "refused", code: "duties_ack_required" });
  }
  if (
    input.method !== "LOCAL_PICKUP" &&
    (!input.shipTo || input.shipTo.country !== input.country)
  ) {
    return withEffects({ kind: "refused", code: "address_required" });
  }

  const checkout = await getSetting("checkout", db);
  const profile = await getSetting("business_profile", db);
  const conversation = await detectConversation(db, {
    email: input.buyer.email,
    lookbackDays: checkout.conversationLookbackDays,
    now: new Date(),
  });

  let created: { order: Order; attempt: PaymentAttempt } | null = null;
  for (let round = 1; round <= 3 && !created; round++) {
    try {
      created = await withTx(
        (tx) =>
          createHeldOrder(tx, {
            input,
            quote,
            provider,
            checkout,
            vatMode: profile.vatMode,
            conversation,
          }),
        { db, name: "checkout.start" },
      );
    } catch (error) {
      if (error instanceof StartAbort) return withEffects(error.result);
      if (
        error instanceof ResumeSignal ||
        isUniqueViolation(error, "orders_client_request_id_unique")
      ) {
        const again = await resumeByClientRequestId(
          db,
          e,
          input.clientRequestId,
          input.locale,
        );
        if (again) return withEffects(again);
      }
      if (error instanceof HoldRefusedError) {
        return withEffects({ kind: "refused", code: error.refusal });
      }
      // A colliding order number (about 1 in 10^9) is retried with a fresh one.
      if (isUniqueViolation(error, "orders_number_unique") && round < 3) {
        continue;
      }
      throw error;
    }
  }
  if (!created) throw new Error("startCheckout: no order created");

  return launchResult(created, provider, input.locale, { db, env: e });
}

async function launchResult(
  created: { order: Order; attempt: PaymentAttempt },
  provider: PaymentProvider,
  locale: Locale,
  deps: StartDeps,
): Promise<ServiceResult<StartCheckoutResult>> {
  const { order, attempt } = created;
  const accessToken = orderAccessToken(order.id, order.accessVersion);
  const launched = await launchAttempt(attempt, order, provider, locale, deps);
  const effects = { revalidate: true };
  if (!launched.ok) {
    return withEffects(
      {
        kind: "provider_error",
        orderId: order.id,
        orderNumber: order.number,
        accessToken,
      },
      effects,
    );
  }
  return withEffects(
    {
      kind: "redirect",
      orderId: order.id,
      orderNumber: order.number,
      accessToken,
      url: launched.url,
    },
    effects,
  );
}

async function createHeldOrder(
  tx: Tx,
  i: {
    input: StartCheckoutInput;
    quote: OkQuote;
    provider: PaymentProvider;
    checkout: CheckoutSettings;
    vatMode: "OSEK_PATUR" | "OSEK_MURSHE";
    conversation: { tookPlace: boolean; source: string | null };
  },
): Promise<{ order: Order; attempt: PaymentAttempt }> {
  const { input, quote } = i;
  const now = new Date();

  // 1. Lock the artworks (before any FK insert that references them) and check the predicate.
  const locked = await lockArtworks(tx, [quote.artworkId]);
  // A concurrent double submit may have committed while we waited for the lock: resume it.
  const [twin] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.clientRequestId, input.clientRequestId));
  if (twin) throw new ResumeSignal();
  const art = locked[0];
  if (!art || !(await allReservable(tx, locked, null, true, now))) {
    throw new StartAbort({ kind: "just_reserved" });
  }
  if (itemPriceMinor(art, quote.currency) !== quote.itemsTotalMinor) {
    throw new StartAbort({ kind: "price_changed", quote });
  }

  // 2–3. Per-buyer advisory locks, then the anti-hoarding caps under them.
  await takeBuyerLocks(tx, {
    email: input.buyer.email,
    ipHash: input.ipHash,
  });
  await checkHoldCaps(tx, {
    email: input.buyer.email,
    ipHash: input.ipHash,
    artworkIds: [art.id],
    excludeOrderId: null,
    settings: i.checkout,
  });

  // 4. The order and its items.
  const until = new Date(
    now.getTime() + i.checkout.reservationMinutes * 60_000,
  );
  const ship = input.method === "LOCAL_PICKUP" ? null : input.shipTo;
  const [order] = await tx
    .insert(orders)
    .values({
      number: newOrderNumber(),
      clientRequestId: input.clientRequestId,
      source: "WEB",
      status: "AWAITING_PAYMENT",
      locale: input.locale,
      currency: quote.currency,
      isDemo: art.isDemo,
      itemsTotalMinor: quote.itemsTotalMinor,
      shippingMinor: quote.shipping.shippingMinor,
      insuranceMinor: quote.shipping.insuranceMinor,
      totalMinor: quote.totalMinor,
      vatMode: i.vatMode,
      vatRateBp: quote.vatRateBp,
      vatMinor: quote.vatMinor,
      fxIlsPerUnit:
        quote.currency === "USD" ? String(i.checkout.fx.ilsPerUsd) : null,
      quoteVersion: 1,
      buyerName: input.buyer.name,
      buyerEmail: input.buyer.email.trim(),
      buyerPhone: input.buyer.phone,
      buyerCompanyName: input.buyer.companyName ?? null,
      buyerVatId: input.buyer.vatId ?? null,
      shipCountry: input.country,
      shipName: ship?.name ?? null,
      shipLine1: ship?.line1 ?? null,
      shipLine2: ship?.line2 ?? null,
      shipCity: ship?.city ?? null,
      shipRegion: ship?.region ?? null,
      shipPostalCode: ship?.postalCode ?? null,
      shipPhone: ship?.phone ?? null,
      shippingMethod: quote.shipping.method,
      shippingQuote: quote.shipping,
      shippingLocked: true,
      termsVersion: input.consents.termsVersion,
      returnsVersion: input.consents.returnsVersion,
      privacyVersion: input.consents.privacyVersion,
      termsAcceptedAt: now,
      ageConfirmedAt: now,
      dutiesNoticeVersion: input.consents.dutiesNoticeVersion ?? null,
      dutiesAckAt: input.consents.dutiesNoticeVersion ? now : null,
      receiptEmailConsent: input.consents.receiptEmailConsent,
      conversationTookPlace: i.conversation.tookPlace,
      conversationSource: i.conversation.source,
      disclosureVersion: LEGAL_VERSIONS.disclosure,
      expiresAt: until,
      holdCount: 1,
      firstHeldAt: now,
      clientIpHash: input.ipHash,
    })
    .returning();
  if (!order) throw new Error("order insert returned no row");
  await tx.insert(orderItems).values({
    orderId: order.id,
    artworkId: art.id,
    titleHe: art.titleHe,
    titleEn: art.titleEn,
    priceMinor: quote.itemsTotalMinor,
    currency: quote.currency,
    declaredValueMinor: art.declaredValueOverrideMinor ?? art.priceIlsMinor,
    snapshot: {
      slug: art.slug,
      inventoryNumber: art.inventoryNumber,
      heightMm: art.heightMm,
      widthMm: art.widthMm,
      depthMm: art.depthMm,
      medium: art.medium,
      surface: art.surface,
      yearCreated: art.yearCreated,
      mediumDetailHe: art.mediumDetailHe,
      mediumDetailEn: art.mediumDetailEn,
      framed: art.framed,
      signed: art.signed,
      coaIncluded: art.coaIncluded,
      isDemo: art.isDemo,
    },
  });

  // 5. The conditional reserve (row count must equal n), 6. takeover expiry.
  const reserved = await reserveArtworks(tx, {
    artworkIds: [art.id],
    orderId: order.id,
    until,
    web: true,
  });
  if (!reserved) throw new StartAbort({ kind: "just_reserved" });
  await expireTakenOverOrders(
    tx,
    locked.map((a) => a.reservedByOrderId),
    order.id,
  );

  // 7. Attempt #1, bound to quote version 1 and the order total.
  const attempt = await insertAttempt(tx, order, 1, i.provider);
  await audit(
    {
      actor: `buyer:${order.number}`,
      action: "order.created",
      entity: "order",
      entityId: order.id,
      after: {
        number: order.number,
        totalMinor: order.totalMinor,
        currency: order.currency,
        method: order.shippingMethod,
        country: order.shipCountry,
        reservedUntil: until.toISOString(),
      },
      ipHash: input.ipHash,
    },
    tx,
  );
  return { order, attempt };
}

async function insertAttempt(
  tx: Tx,
  order: Order,
  seq: number,
  provider: PaymentProvider,
): Promise<PaymentAttempt> {
  const [attempt] = await tx
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      seq,
      provider: PROVIDER_DB_VALUE[provider.id],
      providerMode: provider.mode,
      merchantRef: provider.merchantRef(),
      isDemo: order.isDemo,
      status: "CREATED",
      quoteVersion: order.quoteVersion,
      amountMinor: order.totalMinor,
      currency: order.currency,
      createRequestId: randomUUID(),
    })
    .returning();
  if (!attempt) throw new Error("attempt insert returned no row");
  return attempt;
}

// ---------------------------------------------------------------- startPaymentForOrder

export type PayOrderRefusal =
  | "not_found"
  | "not_payable"
  | "in_flight"
  | "too_many_attempts"
  | "just_reserved"
  | "hold_count_exceeded"
  | "hold_span_exceeded";

class PayRefused extends ConflictError {
  constructor(public readonly refusal: PayOrderRefusal) {
    super("PAY_REFUSED", `pay refused: ${refusal}`, { refusal });
    this.name = "PayRefused";
  }
}

/**
 * `startPaymentForOrder()` (order page "Pay", link orders; spec §5.1 step 4): a new attempt with
 * the current `quote_version`. A live hold is kept (link orders: extended to
 * `greatest(reserved_until, now()+reservationMinutes)`); an expired hold is re-reserved when the
 * works are free, within the §3.5 hold budget (`hold_count ≤ 3`, WEB span ≤ 2 h, caps). Refused
 * while any attempt is CAPTURING or PAYMENT_REVIEW, and for orders no longer AWAITING_PAYMENT
 * (an EXPIRED order is not re-opened here; the buyer starts a new checkout).
 */
export async function startPaymentForOrder(
  input: {
    orderId: string;
    providerId: ProviderId;
    locale: Locale;
    ipHash: string | null;
  },
  deps: StartDeps = {},
): Promise<ServiceResult<StartCheckoutResult>> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const provider = buildProvider(input.providerId, { env: e });
  if (!provider) {
    return withEffects({ kind: "refused", code: "provider_unavailable" });
  }
  const checkout = await getSetting("checkout", db);

  let created: { order: Order; attempt: PaymentAttempt };
  try {
    created = await withTx((tx) => payOrderTx(tx, input, provider, checkout), {
      db,
      name: "checkout.pay_order",
    });
  } catch (error) {
    if (error instanceof PayRefused) {
      return withEffects({ kind: "refused", code: error.refusal });
    }
    if (error instanceof HoldRefusedError) {
      return withEffects({ kind: "refused", code: error.refusal });
    }
    throw error;
  }
  return launchResult(created, provider, input.locale, { db, env: e });
}

async function payOrderTx(
  tx: Tx,
  input: { orderId: string; ipHash: string | null },
  provider: PaymentProvider,
  checkout: CheckoutSettings,
): Promise<{ order: Order; attempt: PaymentAttempt }> {
  const now = new Date();
  const artworkIds = await orderArtworkIds(tx, input.orderId);
  const locked = await lockArtworks(tx, artworkIds);
  const current = await lockOrder(tx, input.orderId);
  if (!current) throw new PayRefused("not_found");
  if (current.status !== "AWAITING_PAYMENT") {
    throw new PayRefused("not_payable");
  }
  if ((await ordersWithAttemptInFlight(tx, [current.id])).size > 0) {
    throw new PayRefused("in_flight");
  }
  const [seqRow] = await tx
    .select({ n: max(paymentAttempts.seq) })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, current.id));
  const seq = (seqRow?.n ?? 0) + 1;
  if (seq > checkout.maxAttemptsPerOrder) {
    throw new PayRefused("too_many_attempts");
  }

  const web = current.source === "WEB";
  const until = new Date(now.getTime() + checkout.reservationMinutes * 60_000);
  const liveHold =
    locked.length > 0 &&
    locked.every(
      (a) =>
        a.reservedByOrderId === current.id &&
        a.reservedUntil !== null &&
        a.reservedUntil.getTime() > now.getTime(),
    );
  let order = current;
  if (liveHold) {
    if (!web) {
      await tx
        .update(artworks)
        .set({
          reservedUntil: sql`greatest(${artworks.reservedUntil}, ${until})`,
        })
        .where(
          and(
            inArray(artworks.id, artworkIds),
            eq(artworks.reservedByOrderId, current.id),
          ),
        );
      order = await updateOrder(tx, current.id, {
        expiresAt: sql`greatest(${orders.expiresAt}, ${until})`,
      });
    }
  } else {
    // Re-reserve an expired (or taken) hold within the budget (spec §3.5).
    if (current.holdCount >= checkout.maxHoldCountPerOrder) {
      throw new PayRefused("hold_count_exceeded");
    }
    if (
      web &&
      current.firstHeldAt &&
      now.getTime() >
        current.firstHeldAt.getTime() + checkout.maxWebHoldSpanMinutes * 60_000
    ) {
      throw new PayRefused("hold_span_exceeded");
    }
    if (!(await allReservable(tx, locked, current.id, web, now))) {
      throw new PayRefused("just_reserved");
    }
    if (current.buyerEmail) {
      await takeBuyerLocks(tx, {
        email: current.buyerEmail,
        ipHash: input.ipHash,
      });
      if (web) {
        await checkHoldCaps(tx, {
          email: current.buyerEmail,
          ipHash: input.ipHash,
          artworkIds,
          excludeOrderId: current.id,
          settings: checkout,
        });
      }
    }
    const ok = await reserveArtworks(tx, {
      artworkIds,
      orderId: current.id,
      until,
      web,
    });
    if (!ok) throw new PayRefused("just_reserved");
    await expireTakenOverOrders(
      tx,
      locked.map((a) => a.reservedByOrderId),
      current.id,
    );
    order = await updateOrder(tx, current.id, {
      expiresAt: until,
      holdCount: sql`${orders.holdCount} + 1`,
      firstHeldAt: current.firstHeldAt ?? now,
    });
  }

  const attempt = await insertAttempt(tx, order, seq, provider);
  await audit(
    {
      actor: `buyer:${order.number}`,
      action: "order.pay_again",
      entity: "order",
      entityId: order.id,
      after: { seq, rehold: !liveHold },
      ipHash: input.ipHash,
    },
    tx,
  );
  return { order, attempt };
}

async function updateOrder(
  tx: Tx,
  orderId: string,
  set: {
    expiresAt?: Date | SQL;
    holdCount?: SQL;
    firstHeldAt?: Date;
  },
): Promise<Order> {
  const [row] = await tx
    .update(orders)
    .set(set)
    .where(eq(orders.id, orderId))
    .returning();
  if (!row) throw new Error("order vanished");
  return row;
}
