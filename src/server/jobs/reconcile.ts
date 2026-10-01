import "server-only";
import { and, asc, inArray, lte, sql } from "drizzle-orm";
import { expireStaleOrders } from "@/server/checkout/release";
import type { Db } from "@/server/db/client";
import { paymentAttempts } from "@/server/db/schema";
import { RECONCILE_ATTEMPT_STATUSES } from "@/server/domain/state-machines";
import { finalizeAttempt } from "@/server/payments/finalize";
import {
  expireRefundLeases,
  reconcileRefund,
  refundsToReconcile,
} from "@/server/payments/refunds";
import {
  processPaymentEvent,
  unprocessedEventIds,
} from "@/server/payments/webhook";
import { type CronJob, forEachWithinBudget } from "./index";

/**
 * `reconcile` cron job, every 5 minutes (spec §5.11). Owner: M2 (commerce lead), then WS2.
 *
 * 1. Replay `payment_events` still unprocessed 2 min – 3 days after arrival (≤ 20).
 * 2. Finalize attempts in PENDING, AWAITING_CAPTURE, CAPTURING or PAYMENT_REVIEW whose
 *    `next_check_at ≤ now()`, oldest first (deferred PENDING attempts carry a `next_check_at` too).
 *    `finalizeAttempt` applies the backoff ladder (2m, 5m, 15m, 30m, 1h, 2h, then 4h) and the watch
 *    windows; a CAPTURING attempt re-enters its capture claim, which re-extends the hold.
 * 3. Expired IN_FLIGHT refund leases → UNKNOWN; PROVIDER_PENDING / UNKNOWN refunds → `getRefund`
 *    (never a second refund call).
 * 4. AWAITING_PAYMENT orders past `expires_at` with no in-flight attempt → EXPIRED, holds released
 *    (artworks first). Link-order requests → EXPIRED lands with link orders (WS2).
 *
 * Idempotent (every step is a compare-and-set); nothing new starts once `ctx.expired()`; at most
 * `PROVIDER_CONCURRENCY` provider calls in flight. Outbox jobs the steps enqueue are sent by the
 * `outbox` job (or the next `after()` batch).
 */
export const RECONCILE_EVENT_LIMIT = 20;
export const RECONCILE_ATTEMPT_LIMIT = 50;
export const RECONCILE_REFUND_LIMIT = 20;
export const RECONCILE_EXPIRE_LIMIT = 100;

export const reconcileJob: CronJob = async (ctx) => {
  // `runCronJob` passes the pool, never a transaction: each step runs its own short transactions.
  const db = ctx.db as Db;

  // 1. Unprocessed webhook events.
  const eventIds = await unprocessedEventIds(RECONCILE_EVENT_LIMIT, db);
  let eventsFailed = 0;
  const events = await forEachWithinBudget(ctx, eventIds, async (id) => {
    const outcome = await processPaymentEvent(id, {}, { db });
    if (outcome.status >= 500) eventsFailed += 1;
  });

  // 2. Attempts due for a provider check.
  const due = ctx.expired()
    ? []
    : await db
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(
          and(
            inArray(paymentAttempts.status, [...RECONCILE_ATTEMPT_STATUSES]),
            lte(paymentAttempts.nextCheckAt, sql`now()`),
          ),
        )
        .orderBy(asc(paymentAttempts.nextCheckAt))
        .limit(RECONCILE_ATTEMPT_LIMIT);
  const outcomes: Record<string, number> = {};
  const attempts = await forEachWithinBudget(ctx, due, async ({ id }) => {
    const { result } = await finalizeAttempt(id, { trigger: "reconcile", db });
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  });

  // 3. Refunds: leases, then provider-side status.
  const leasesExpired = ctx.expired() ? 0 : await expireRefundLeases({ db });
  const refundIds = ctx.expired()
    ? []
    : await refundsToReconcile(RECONCILE_REFUND_LIMIT, db);
  const refundStatuses: Record<string, number> = {};
  const refunds = await forEachWithinBudget(ctx, refundIds, async (id) => {
    const { result } = await reconcileRefund(id, { db });
    refundStatuses[result.status] = (refundStatuses[result.status] ?? 0) + 1;
  });

  // 4. Lapsed holds.
  const expired = ctx.expired()
    ? 0
    : (
        await expireStaleOrders(
          { limit: RECONCILE_EXPIRE_LIMIT, deadline: ctx.deadline },
          { db },
        )
      ).result.expired;

  return {
    events: { ...events, failed: events.failed + eventsFailed },
    attempts: { ...attempts, outcomes },
    refunds: { ...refunds, leasesExpired, statuses: refundStatuses },
    ordersExpired: expired,
  };
};
