import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { raiseAlert } from "@/server/alerts/service";
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
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import { isUniqueViolation } from "@/server/domain/errors";
import { transition } from "@/server/domain/transition";
import { enqueueEmail } from "@/server/outbox/enqueue";
import {
  isNonFinalAttempt,
  type LockedPaymentContext,
  lockPaymentContext,
  otherAttemptInFlight,
  quoteBound,
} from "./apply";
import type { FinalizeTrigger } from "./finalize";

/**
 * The capture claim (spec §5.2 `requires_capture`, `capture.ts`). Re-entrant:
 *
 * 1. **Claim transaction** (artworks → order → attempt): the order must be AWAITING_PAYMENT or
 *    EXPIRED and not paid or in flight by another attempt; the quote bound; every work sellable.
 *    Then re-reserve with `greatest(coalesce(reserved_until, now()), now()+10 min)`, mirror it on
 *    the order (EXPIRED → AWAITING_PAYMENT), and run the conditional CAPTURING UPDATE (re-entry
 *    for reconcile/admin, or when `last_checked_at` is older than 60 s). Zero rows → another worker
 *    is capturing right now (`busy`).
 * 2. Not sellable / another winner (or a 23505 on the winner index) → CANCELED, nothing captured,
 *    `purchase-not-completed` ("you were not charged").
 * 3. **Capture watch**: 6 tries or 24 h in CAPTURING with the provider still reporting an
 *    approval → CANCELED, hold released, CRITICAL alert.
 *
 * The provider `capture` call itself runs in `finalize.ts`, outside any transaction, with the
 * claimed `capture_request_id` (the same key on every re-entry).
 */
export const CAPTURE_HOLD_MINUTES = 10;
export const CAPTURE_MAX_TRIES = 6;
export const CAPTURE_WATCH_MS = 24 * 60 * 60_000;
const REENTRY_AFTER_SEC = 60;

export type ClaimResult =
  | { kind: "claimed"; attempt: PaymentAttempt }
  | { kind: "busy" }
  | { kind: "already_final" }
  | { kind: "canceled"; lost: boolean; reason: string };

async function cancelUncaptured(
  tx: Tx,
  ctx: LockedPaymentContext,
  reason: string,
  opts: { lost: boolean; releaseHold?: boolean },
): Promise<ClaimResult> {
  const { attempt, order } = ctx;
  const now = new Date();
  await transition(
    tx,
    "attempt",
    attempt.id,
    [attempt.status],
    "CANCELED",
    {
      failureReason: reason,
      finalizedAt: now,
      lastCheckedAt: now,
      nextCheckAt: null,
    },
    "system",
  );
  if (opts.releaseHold) {
    // The watch ran out: the hold ends now (the expiry sweep releases it).
    await tx
      .update(artworks)
      .set({ reservedUntil: now })
      .where(sql`${artworks.reservedByOrderId} = ${order.id}`);
    await tx
      .update(orders)
      .set({ expiresAt: now })
      .where(
        sql`${orders.id} = ${order.id} AND ${orders.status} = 'AWAITING_PAYMENT'`,
      );
  }
  if (opts.lost && order.buyerEmail) {
    await enqueueEmail(tx, {
      template: "purchase-not-completed",
      to: order.buyerEmail,
      locale: order.locale,
      refId: attempt.id,
    });
  }
  return { kind: "canceled", lost: opts.lost, reason };
}

export async function claimCapture(
  attemptId: string,
  trigger: FinalizeTrigger,
  deps: { db?: Db } = {},
): Promise<ClaimResult> {
  const db = deps.db ?? defaultDb;
  try {
    return await withTx((tx) => claimTx(tx, attemptId, trigger), {
      db,
      name: "payments.capture_claim",
    });
  } catch (error) {
    if (!isUniqueViolation(error, "payment_attempts_one_winner_idx")) {
      throw error;
    }
    // Another attempt became the winner between our check and the UPDATE.
    return withTx(
      async (tx) => {
        const ctx = await lockPaymentContext(tx, attemptId);
        if (!isNonFinalAttempt(ctx.attempt.status)) {
          return { kind: "already_final" } as const;
        }
        return cancelUncaptured(tx, ctx, "LOST_BEFORE_CAPTURE", { lost: true });
      },
      { db, name: "payments.capture_lost" },
    );
  }
}

async function claimTx(
  tx: Tx,
  attemptId: string,
  trigger: FinalizeTrigger,
): Promise<ClaimResult> {
  const ctx = await lockPaymentContext(tx, attemptId);
  const { attempt, order, locked } = ctx;
  const now = new Date();
  if (
    !isNonFinalAttempt(attempt.status) ||
    attempt.status === "PAYMENT_REVIEW"
  ) {
    return { kind: "already_final" };
  }

  // Capture watch: the approval was never captured in 6 tries or 24 h.
  if (
    attempt.status === "CAPTURING" &&
    (attempt.captureTries >= CAPTURE_MAX_TRIES ||
      (attempt.capturingSince !== null &&
        now.getTime() - attempt.capturingSince.getTime() > CAPTURE_WATCH_MS))
  ) {
    const result = await cancelUncaptured(tx, ctx, "CAPTURE_WATCH_EXPIRED", {
      lost: false,
      releaseHold: true,
    });
    await raiseAlert(
      {
        severity: "CRITICAL",
        kind: "CAPTURE_WATCH_EXPIRED",
        dedupeKey: `capture-watch:${attempt.id}`,
        entity: "payment_attempt",
        entityId: attempt.id,
        params: { orderNumber: order.number, tries: attempt.captureTries },
      },
      tx,
    );
    return result;
  }

  if (
    !["AWAITING_PAYMENT", "EXPIRED"].includes(order.status) ||
    (attempt.status !== "CAPTURING" &&
      (await otherAttemptInFlight(tx, attempt)))
  ) {
    return cancelUncaptured(tx, ctx, "LOST_BEFORE_CAPTURE", { lost: true });
  }
  if (!quoteBound(attempt, order)) {
    return cancelUncaptured(tx, ctx, "STALE_QUOTE", { lost: false });
  }
  if (!(await allSellable(tx, locked, order.id, now))) {
    return cancelUncaptured(tx, ctx, "LOST_BEFORE_CAPTURE", { lost: true });
  }

  // Re-reserve (or extend) for the capture window, and mirror it on the order.
  const ids = locked.map((a) => a.id);
  if (ids.length > 0) {
    await tx
      .update(artworks)
      .set({
        reservedByOrderId: order.id,
        reservedUntil: sql`greatest(coalesce(${artworks.reservedUntil}, now()), now() + make_interval(mins => ${CAPTURE_HOLD_MINUTES}::int))`,
      })
      .where(inArray(artworks.id, ids));
    await expireTakenOverOrders(
      tx,
      locked.map((a) => a.reservedByOrderId),
      order.id,
    );
  }
  await tx
    .update(orders)
    .set({
      expiresAt: sql`greatest(coalesce(${orders.expiresAt}, now()), now() + make_interval(mins => ${CAPTURE_HOLD_MINUTES}::int))`,
    })
    .where(sql`${orders.id} = ${order.id}`);
  if (order.status === "EXPIRED") {
    await transition(
      tx,
      "order",
      order.id,
      ["EXPIRED"],
      "AWAITING_PAYMENT",
      { statusReason: null },
      "system",
      { action: "order.reopened_for_capture" },
    );
  }

  const reentryAllowed = trigger === "reconcile" || trigger === "admin";
  const claimed = await tx.execute<Record<string, unknown>>(sql`
    UPDATE payment_attempts
       SET status = 'CAPTURING',
           capture_request_id = coalesce(capture_request_id, gen_random_uuid()),
           capturing_since = coalesce(capturing_since, now()),
           capture_tries = capture_tries + 1,
           last_checked_at = now(),
           next_check_at = now() + interval '2 minutes',
           updated_at = now()
     WHERE id = ${attempt.id}
       AND (status IN ('PENDING', 'AWAITING_CAPTURE', 'EXPIRED')
            OR (status = 'CAPTURING' AND (${reentryAllowed} OR last_checked_at < now() - make_interval(secs => ${REENTRY_AFTER_SEC}::int))))
    RETURNING id`);
  if (claimed.rows.length === 0) return { kind: "busy" };
  const [row] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attempt.id));
  if (!row) return { kind: "busy" };
  return { kind: "claimed", attempt: row };
}
