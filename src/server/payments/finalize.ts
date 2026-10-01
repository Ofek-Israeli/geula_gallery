import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { raiseAlert } from "@/server/alerts/service";
import { audit } from "@/server/audit";
import {
  allSellable,
  expireTakenOverOrders,
} from "@/server/checkout/reservations";
import { type Db, db as defaultDb, type Tx } from "@/server/db/client";
import {
  artworks,
  orders,
  type PaymentAttempt,
  paymentAttempts,
  refunds,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import {
  type Effects,
  type ServiceResult,
  withEffects,
} from "@/server/domain/effects";
import { isUniqueViolation, NotFoundError } from "@/server/domain/errors";
import {
  type AttemptStatus,
  canTransition,
  type OrderStatus,
} from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { env as defaultEnv, type Env } from "@/server/env";
import { log } from "@/server/log";
import { enqueueEmail } from "@/server/outbox/enqueue";
import { getSetting } from "@/server/settings";
import {
  type ApplyOutcome,
  applySuccessfulPayment,
  isNonFinalAttempt,
  lockPaymentContext,
  markNeedsRefund,
  otherAttemptInFlight,
  paymentDetails,
  quoteBound,
} from "./apply";
import { claimCapture } from "./capture";
import { MOCK_WATCH_HOURS } from "./providers/mock";
import { providerForAttempt } from "./registry";
import type { PaymentProvider, VerifiedPayment } from "./types";

/**
 * `finalizeAttempt()` (spec §1.1.2, §5.2; frozen contract). The one idempotent finalizer, called by
 * the webhook, the return route, the reconcile cron and the admin "Recheck payment" button:
 *
 * 1. load the attempt without locks (final → `already_final`);
 * 2. `providerForAttempt` (drift → `config_drift`);
 * 3. `fetchPayment()` with **no locks held** (error → `unknown`, next check scheduled);
 * 4. verify exactly: echoed reference, merchant ref, amount and currency (mismatch with money
 *    taken → NEEDS_REFUND AMOUNT_MISMATCH with a MANUAL_REQUIRED refund; without → FAILED);
 * 5. quote binding (inside the locked transactions: stale → STALE_QUOTE refund, or a CANCELED
 *    capture claim);
 * 6. branch on the verified state, each branch one short compare-and-set transaction.
 *
 * A verified success always ends as a sale or a tracked refund.
 */
export type FinalizeTrigger = "webhook" | "return" | "reconcile" | "admin";

export type FinalizeOutcome =
  /** The verified success was applied: order PAID, sale recorded. */
  | "paid"
  /** The attempt was already final; nothing changed. */
  | "already_final"
  /** The provider still reports a non-final state (next check scheduled). */
  | "pending"
  /** Capture claimed; the capture call failed or is still settling (reconcile re-enters). */
  | "capturing"
  | "review"
  /** A verified success that cannot be applied → NEEDS_REFUND (refund requested). */
  | "needs_refund"
  | "failed"
  | "canceled"
  | "expired"
  /** Refunded at the provider before we finalized (EXTERNAL refund row). */
  | "refunded"
  /** Another attempt of the order is capturing / in review: re-evaluated later. */
  | "deferred"
  /** The capture claim found the work gone: nothing captured. */
  | "lost_before_capture"
  | "config_drift"
  /** The provider could not be asked (error, not configured): a retry is scheduled. */
  | "unknown";

export interface FinalizeResult {
  attemptId: string;
  orderId: string;
  outcome: FinalizeOutcome;
  attemptStatus: AttemptStatus;
  orderStatus: OrderStatus;
}

export interface FinalizeOptions {
  trigger: FinalizeTrigger;
  db?: Db;
  env?: Env;
}

/** Reconcile backoff (spec §5.11): 2m, 5m, 15m, 30m, 1h, 2h, then every 4h. */
const BACKOFF_MINUTES = [2, 5, 15, 30, 60, 120] as const;
export function nextCheckDelayMs(checkCount: number): number {
  const minutes = BACKOFF_MINUTES[checkCount] ?? 240;
  return minutes * 60_000;
}

/** Watch window for a pending attempt (spec §5.2 step 6). */
export function watchWindowMs(
  provider: PaymentAttempt["provider"],
  e: Env,
): number {
  const hours =
    provider === "MOCK"
      ? MOCK_WATCH_HOURS
      : provider === "CARDCOM"
        ? e.CARDCOM_LATE_WATCH_HOURS
        : 72;
  return hours * 60 * 60_000;
}

const CHANGED: Effects = { outbox: true, revalidate: true };

interface Ctx {
  db: Db;
  env: Env;
  trigger: FinalizeTrigger;
  actor: string;
}

export async function finalizeAttempt(
  attemptId: string,
  opts: FinalizeOptions,
): Promise<ServiceResult<FinalizeResult>> {
  const c: Ctx = {
    db: opts.db ?? defaultDb,
    env: opts.env ?? defaultEnv,
    trigger: opts.trigger,
    actor: `system:${opts.trigger}`,
  };
  const [attempt] = await c.db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId));
  if (!attempt) throw new NotFoundError("payment_attempt", attemptId);

  const done = async (outcome: FinalizeOutcome, effects: Effects = {}) =>
    withEffects(await resultOf(c, attemptId, outcome), effects);

  if (!isNonFinalAttempt(attempt.status)) return done("already_final");
  if (attempt.provider === "OFFLINE") return done("already_final");

  const pfa = await providerForAttempt(attempt, { env: c.env, db: c.db });
  if (pfa.kind === "config_drift") return done("config_drift");
  if (pfa.kind !== "ok" || !attempt.providerRef) {
    await scheduleCheck(c, attempt);
    return done(pfa.kind === "ok" ? "pending" : "unknown");
  }
  const provider = pfa.provider;

  let vp: VerifiedPayment;
  try {
    vp = await provider.fetchPayment({
      providerRef: attempt.providerRef,
      attemptId: attempt.id,
    });
  } catch (error) {
    log.warn("payments.fetch_failed", {
      attemptId,
      error: error instanceof Error ? error.name : "unknown",
    });
    await scheduleCheck(c, attempt);
    return done("unknown");
  }

  const handled = await handleVerified(c, attempt, provider, vp);
  return done(handled.outcome, handled.effects);
}

async function resultOf(
  c: Ctx,
  attemptId: string,
  outcome: FinalizeOutcome,
): Promise<FinalizeResult> {
  const [row] = await c.db
    .select({
      attemptStatus: paymentAttempts.status,
      orderId: orders.id,
      orderStatus: orders.status,
    })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(eq(paymentAttempts.id, attemptId));
  if (!row) throw new NotFoundError("payment_attempt", attemptId);
  return { attemptId, outcome, ...row };
}

type Handled = { outcome: FinalizeOutcome; effects?: Effects };

/** Money moved (or is held) at the provider in these states. */
const MONEY_STATES = new Set([
  "requires_capture",
  "review",
  "succeeded",
  "refunded",
  "partially_refunded",
]);

export function verificationProblems(
  attempt: Pick<
    PaymentAttempt,
    "id" | "merchantRef" | "amountMinor" | "currency"
  >,
  vp: VerifiedPayment,
): string[] {
  const problems: string[] = [];
  if (vp.echoedReference !== attempt.id) problems.push("reference");
  if (vp.merchantRef !== attempt.merchantRef) problems.push("merchant");
  if (!vp.amount) problems.push("amount_missing");
  else {
    if (vp.amount.amountMinor !== attempt.amountMinor) problems.push("amount");
    if (vp.amount.currency !== attempt.currency) problems.push("currency");
  }
  return problems;
}

async function handleVerified(
  c: Ctx,
  attempt: PaymentAttempt,
  provider: PaymentProvider,
  vp: VerifiedPayment,
): Promise<Handled> {
  if (MONEY_STATES.has(vp.state)) {
    const problems = verificationProblems(attempt, vp);
    if (problems.length > 0) return handleMismatch(c, attempt, vp, problems);
  }
  switch (vp.state) {
    case "pending":
      return handlePending(c, attempt);
    case "failed":
    case "canceled":
    case "expired":
      return handleNegative(c, attempt.id, vp);
    case "refunded":
      return handleExternallyRefunded(c, attempt.id, vp);
    case "partially_refunded":
      await recordExternalPartialRefund(c, attempt.id, vp);
      return handleSuccess(c, attempt.id, vp);
    case "requires_capture":
      return handleCapture(c, attempt, provider);
    case "review":
      return handleReview(c, attempt.id, vp);
    case "succeeded":
      return handleSuccess(c, attempt.id, vp);
  }
}

// ---------------------------------------------------------------- pending

async function scheduleCheck(c: Ctx, attempt: PaymentAttempt): Promise<void> {
  const now = Date.now();
  await c.db
    .update(paymentAttempts)
    .set({
      checkCount: sql`${paymentAttempts.checkCount} + 1`,
      lastCheckedAt: new Date(now),
      nextCheckAt: new Date(now + nextCheckDelayMs(attempt.checkCount)),
    })
    .where(eq(paymentAttempts.id, attempt.id));
}

async function handlePending(
  c: Ctx,
  attempt: PaymentAttempt,
): Promise<Handled> {
  const window = watchWindowMs(attempt.provider, c.env);
  const watched = ["CREATED", "PENDING", "AWAITING_CAPTURE"].includes(
    attempt.status,
  );
  if (watched && Date.now() - attempt.createdAt.getTime() > window) {
    const tail =
      attempt.provider === "CARDCOM"
        ? new Date(
            attempt.createdAt.getTime() +
              c.env.CARDCOM_TAIL_DAYS * 24 * 60 * 60_000,
          )
        : null;
    await withTx(
      async (tx) => {
        const ctx = await lockPaymentContext(tx, attempt.id);
        if (
          !["CREATED", "PENDING", "AWAITING_CAPTURE"].includes(
            ctx.attempt.status,
          )
        ) {
          return;
        }
        await transition(
          tx,
          "attempt",
          attempt.id,
          [ctx.attempt.status],
          "EXPIRED",
          {
            tailUntil: tail,
            lastCheckedAt: new Date(),
            nextCheckAt: null,
          },
          c.actor,
        );
      },
      { db: c.db, name: "payments.attempt_expired" },
    );
    return { outcome: "expired" };
  }
  if (attempt.status === "EXPIRED") return { outcome: "expired" };
  await scheduleCheck(c, attempt);
  return { outcome: "pending" };
}

// ---------------------------------------------------------------- failed / canceled / expired

async function handleNegative(
  c: Ctx,
  attemptId: string,
  vp: VerifiedPayment,
): Promise<Handled> {
  const target: AttemptStatus =
    vp.state === "failed"
      ? "FAILED"
      : vp.state === "canceled"
        ? "CANCELED"
        : "EXPIRED";
  const outcome: FinalizeOutcome =
    target === "FAILED"
      ? "failed"
      : target === "CANCELED"
        ? "canceled"
        : "expired";
  const changed = await withTx(
    async (tx) => {
      const ctx = await lockPaymentContext(tx, attemptId);
      const { attempt, order } = ctx;
      if (!isNonFinalAttempt(attempt.status)) return false;
      const now = new Date();

      if (attempt.status === "PAYMENT_REVIEW" && target === "FAILED") {
        // Review DENIED: the one explicit exception to `greatest(...)`: the hold is shortened to
        // now()+reservationMinutes (spec §3.5), audited.
        const checkout = await getSetting("checkout", tx);
        const until = new Date(
          now.getTime() + checkout.reservationMinutes * 60_000,
        );
        await transition(
          tx,
          "attempt",
          attempt.id,
          ["PAYMENT_REVIEW"],
          "FAILED",
          {
            failureReason: "REVIEW_DENIED",
            finalizedAt: now,
            lastCheckedAt: now,
            nextCheckAt: null,
          },
          c.actor,
        );
        if (order.status === "PAYMENT_REVIEW") {
          await tx
            .update(artworks)
            .set({ reservedUntil: until })
            .where(eq(artworks.reservedByOrderId, order.id));
          await transition(
            tx,
            "order",
            order.id,
            ["PAYMENT_REVIEW"],
            "AWAITING_PAYMENT",
            { expiresAt: until, fulfillmentBlockedReason: null },
            c.actor,
            { action: "order.review_denied_hold_shortened" },
          );
        }
        return true;
      }
      if (
        attempt.status === target ||
        !canTransition("attempt", attempt.status, target)
      ) {
        return false;
      }
      await transition(
        tx,
        "attempt",
        attempt.id,
        [attempt.status],
        target,
        {
          failureReason: vp.state,
          finalizedAt: target === "EXPIRED" ? null : now,
          lastCheckedAt: now,
          nextCheckAt: null,
        },
        c.actor,
      );
      return true;
    },
    { db: c.db, name: "payments.negative" },
  );
  return { outcome, effects: changed ? { revalidate: true } : {} };
}

// ---------------------------------------------------------------- verification mismatch

async function handleMismatch(
  c: Ctx,
  attempt: PaymentAttempt,
  vp: VerifiedPayment,
  problems: string[],
): Promise<Handled> {
  const moneyTaken = vp.state !== "requires_capture";
  log.error("payments.verification_mismatch", {
    attemptId: attempt.id,
    problems,
    state: vp.state,
  });
  const outcome = await withTx(
    async (tx): Promise<FinalizeOutcome> => {
      const ctx = await lockPaymentContext(tx, attempt.id);
      if (!isNonFinalAttempt(ctx.attempt.status)) return "already_final";
      if (moneyTaken) {
        await markNeedsRefund(tx, ctx, {
          reason: "AMOUNT_MISMATCH",
          verified: vp,
          amountMinor: vp.amount?.amountMinor ?? ctx.attempt.amountMinor,
          actor: c.actor,
        });
        return "needs_refund";
      }
      if (!canTransition("attempt", ctx.attempt.status, "FAILED")) {
        return "already_final";
      }
      await transition(
        tx,
        "attempt",
        attempt.id,
        [ctx.attempt.status],
        "FAILED",
        {
          failureReason: `MISMATCH:${problems.join(",")}`,
          finalizedAt: new Date(),
          nextCheckAt: null,
        },
        c.actor,
      );
      await raiseAlert(
        {
          severity: "CRITICAL",
          kind: "PAYMENT_MISMATCH",
          dedupeKey: `payment-mismatch:${attempt.id}`,
          entity: "payment_attempt",
          entityId: attempt.id,
          params: { problems: problems.join(",") },
        },
        tx,
      );
      return "failed";
    },
    { db: c.db, name: "payments.mismatch" },
  );
  return { outcome, effects: CHANGED };
}

// ---------------------------------------------------------------- refunded at the provider

async function handleExternallyRefunded(
  c: Ctx,
  attemptId: string,
  vp: VerifiedPayment,
): Promise<Handled> {
  const outcome = await withTx(
    async (tx): Promise<FinalizeOutcome> => {
      const ctx = await lockPaymentContext(tx, attemptId);
      const { attempt } = ctx;
      if (!isNonFinalAttempt(attempt.status)) return "already_final";
      const amount =
        vp.refundedMinor ?? vp.amount?.amountMinor ?? attempt.amountMinor;
      await insertExternalRefund(tx, attempt, amount);
      await transition(
        tx,
        "attempt",
        attempt.id,
        [attempt.status],
        "REFUNDED",
        {
          ...paymentDetails(vp),
          failureReason: "REFUNDED_AT_PROVIDER",
          finalizedAt: new Date(),
          nextCheckAt: null,
        },
        c.actor,
      );
      await raiseAlert(
        {
          severity: "WARNING",
          kind: "PAYMENT_REFUNDED_EXTERNALLY",
          dedupeKey: `refunded-externally:${attempt.id}`,
          entity: "payment_attempt",
          entityId: attempt.id,
          params: { amountMinor: amount },
        },
        tx,
      );
      return "refunded";
    },
    { db: c.db, name: "payments.external_refund" },
  );
  return { outcome, effects: CHANGED };
}

async function insertExternalRefund(
  tx: Tx,
  attempt: PaymentAttempt,
  amountMinor: number,
): Promise<boolean> {
  const existing = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(eq(refunds.attemptId, attempt.id), eq(refunds.reason, "EXTERNAL")),
    )
    .limit(1);
  if (existing.length > 0 || amountMinor <= 0) return false;
  await tx.insert(refunds).values({
    attemptId: attempt.id,
    orderId: attempt.orderId,
    amountMinor,
    currency: attempt.currency,
    reason: "EXTERNAL",
    status: "SUCCEEDED",
    idemKey: randomUUID(),
    requestedBy: `provider:${attempt.provider.toLowerCase()}`,
    completedAt: new Date(),
  });
  return true;
}

async function recordExternalPartialRefund(
  c: Ctx,
  attemptId: string,
  vp: VerifiedPayment,
): Promise<void> {
  await withTx(
    async (tx) => {
      const ctx = await lockPaymentContext(tx, attemptId);
      if (!isNonFinalAttempt(ctx.attempt.status)) return;
      const inserted = await insertExternalRefund(
        tx,
        ctx.attempt,
        vp.refundedMinor ?? 0,
      );
      if (inserted) {
        await raiseAlert(
          {
            severity: "CRITICAL",
            kind: "PAYMENT_PARTIALLY_REFUNDED",
            dedupeKey: `partially-refunded:${attemptId}`,
            entity: "payment_attempt",
            entityId: attemptId,
            params: { refundedMinor: vp.refundedMinor ?? 0 },
          },
          tx,
        );
      }
    },
    { db: c.db, name: "payments.partial_refund" },
  );
}

// ---------------------------------------------------------------- succeeded

const CONFLICT_INDEXES = [
  "payment_attempts_one_winner_idx",
  "sales_one_active_per_artwork_idx",
  "sales_one_active_per_order_item_idx",
] as const;

function outcomeOf(a: ApplyOutcome): FinalizeOutcome {
  switch (a.kind) {
    case "applied":
      return "paid";
    case "needs_refund":
      return "needs_refund";
    case "already_applied":
      return "already_final";
    case "deferred":
      return "deferred";
  }
}

async function handleSuccess(
  c: Ctx,
  attemptId: string,
  vp: VerifiedPayment,
): Promise<Handled> {
  let applied: ApplyOutcome;
  try {
    applied = await withTx(
      (tx) =>
        applySuccessfulPayment(tx, { attemptId, verified: vp, actor: c.actor }),
      { db: c.db, name: "payments.apply" },
    );
  } catch (error) {
    const index = CONFLICT_INDEXES.find((i) => isUniqueViolation(error, i));
    if (!index) throw error;
    // The aborted transaction is gone; route the money to a refund in a new one (spec §5.2 9).
    applied = await withTx(
      async (tx) => {
        const ctx = await lockPaymentContext(tx, attemptId);
        const amount =
          (vp.amount?.amountMinor ?? ctx.attempt.amountMinor) -
          (vp.refundedMinor ?? 0);
        return markNeedsRefund(tx, ctx, {
          reason:
            index === "payment_attempts_one_winner_idx"
              ? "DUPLICATE_PAYMENT"
              : "LOST_RESERVATION",
          verified: vp,
          amountMinor: amount,
          actor: c.actor,
        });
      },
      { db: c.db, name: "payments.needs_refund_after_conflict" },
    );
  }
  const outcome = outcomeOf(applied);
  return {
    outcome,
    effects: outcome === "paid" || outcome === "needs_refund" ? CHANGED : {},
  };
}

// ---------------------------------------------------------------- review

async function handleReview(
  c: Ctx,
  attemptId: string,
  vp: VerifiedPayment,
): Promise<Handled> {
  const outcome = await withTx(
    async (tx): Promise<FinalizeOutcome> => {
      const ctx = await lockPaymentContext(tx, attemptId);
      const { attempt, order, locked } = ctx;
      const now = new Date();
      if (attempt.status === "PAYMENT_REVIEW") {
        await tx
          .update(paymentAttempts)
          .set({
            lastCheckedAt: now,
            checkCount: sql`${paymentAttempts.checkCount} + 1`,
            nextCheckAt: new Date(
              now.getTime() + nextCheckDelayMs(attempt.checkCount),
            ),
          })
          .where(eq(paymentAttempts.id, attempt.id));
        return "review";
      }
      if (!isNonFinalAttempt(attempt.status)) return "already_final";
      const eligible =
        canTransition("attempt", attempt.status, "PAYMENT_REVIEW") &&
        ["AWAITING_PAYMENT", "EXPIRED"].includes(order.status) &&
        quoteBound(attempt, order) &&
        !(await otherAttemptInFlight(tx, attempt)) &&
        (await allSellable(tx, locked, order.id, now));
      if (!eligible) {
        // The money is not final yet; when the review resolves, a success that cannot be applied
        // becomes NEEDS_REFUND through `applySuccessfulPayment`.
        await tx
          .update(paymentAttempts)
          .set({
            lastCheckedAt: now,
            nextCheckAt: new Date(
              now.getTime() + nextCheckDelayMs(attempt.checkCount),
            ),
            checkCount: sql`${paymentAttempts.checkCount} + 1`,
          })
          .where(eq(paymentAttempts.id, attempt.id));
        return "pending";
      }
      const reviewUntil = sql`greatest(coalesce(${artworks.reservedUntil}, now()), now() + interval '7 days')`;
      const ids = locked.map((a) => a.id);
      if (ids.length > 0) {
        await tx
          .update(artworks)
          .set({ reservedByOrderId: order.id, reservedUntil: reviewUntil })
          .where(inArray(artworks.id, ids));
        await expireTakenOverOrders(
          tx,
          locked.map((a) => a.reservedByOrderId),
          order.id,
        );
      }
      if (order.status === "EXPIRED") {
        await transition(
          tx,
          "order",
          order.id,
          ["EXPIRED"],
          "AWAITING_PAYMENT",
          { statusReason: null },
          c.actor,
        );
      }
      await transition(
        tx,
        "attempt",
        attempt.id,
        [attempt.status],
        "PAYMENT_REVIEW",
        {
          ...paymentDetails(vp),
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + nextCheckDelayMs(0)),
        },
        c.actor,
      );
      await tx
        .update(orders)
        .set({
          expiresAt: sql`greatest(coalesce(${orders.expiresAt}, now()), now() + interval '7 days')`,
        })
        .where(eq(orders.id, order.id));
      await transition(
        tx,
        "order",
        order.id,
        ["AWAITING_PAYMENT"],
        "PAYMENT_REVIEW",
        { fulfillmentBlockedReason: "PAYMENT_REVIEW" },
        c.actor,
      );
      if (order.buyerEmail) {
        await enqueueEmail(tx, {
          template: "payment-review",
          to: order.buyerEmail,
          locale: order.locale,
          refId: attempt.id,
        });
      }
      await audit(
        {
          actor: c.actor,
          action: "payment.review",
          entity: "order",
          entityId: order.id,
          after: { attemptId: attempt.id },
        },
        tx,
      );
      return "review";
    },
    { db: c.db, name: "payments.review" },
  );
  return { outcome, effects: outcome === "review" ? CHANGED : {} };
}

// ---------------------------------------------------------------- requires_capture

async function handleCapture(
  c: Ctx,
  attempt: PaymentAttempt,
  provider: PaymentProvider,
): Promise<Handled> {
  if (!provider.capture) {
    await scheduleCheck(c, attempt);
    return { outcome: "pending" };
  }
  const claim = await claimCapture(attempt.id, c.trigger, { db: c.db });
  switch (claim.kind) {
    case "busy":
      return { outcome: "pending" };
    case "already_final":
      return { outcome: "already_final" };
    case "canceled":
      return {
        outcome: claim.lost ? "lost_before_capture" : "canceled",
        effects: CHANGED,
      };
    case "claimed":
      break;
  }
  const claimed = claim.attempt;
  let vp: VerifiedPayment;
  try {
    vp = await provider.capture({
      providerRef: claimed.providerRef ?? "",
      idemKey: claimed.captureRequestId ?? claimed.id,
    });
  } catch (error) {
    // Unknown outcome: stay CAPTURING; reconcile GETs first, then re-enters with the same key.
    log.warn("payments.capture_failed", {
      attemptId: attempt.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    await c.db
      .update(paymentAttempts)
      .set({ nextCheckAt: new Date(Date.now() + 2 * 60_000) })
      .where(eq(paymentAttempts.id, attempt.id));
    return { outcome: "capturing", effects: { revalidate: true } };
  }
  if (vp.state === "requires_capture" || vp.state === "pending") {
    return { outcome: "capturing", effects: { revalidate: true } };
  }
  return handleVerified(c, claimed, provider, vp);
}
