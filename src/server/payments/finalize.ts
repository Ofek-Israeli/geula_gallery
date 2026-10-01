import "server-only";
import type { DbOrTx } from "@/server/db/client";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";
import type {
  AttemptStatus,
  OrderStatus,
} from "@/server/domain/state-machines";

/**
 * `finalizeAttempt()` (spec §1.1.2, §5.2; frozen contract). The one idempotent finalizer, called by
 * the webhook, the return route, the reconcile cron and the admin "Recheck payment" button:
 * re-query the provider with no locks held, verify exactly (amount, currency, echoed reference,
 * merchant ref, quote binding), then run one short compare-and-set transaction. A verified success
 * always ends as a sale or a tracked refund. Body: M2 commerce lead.
 */
export type FinalizeTrigger = "webhook" | "return" | "reconcile" | "admin";

export type FinalizeOutcome =
  /** The verified success was applied: order PAID, sale recorded. */
  | "applied"
  /** The attempt was already final; nothing changed. */
  | "already_final"
  /** The provider still reports a non-final state (next check scheduled). */
  | "pending"
  /** Capture claimed or in review. */
  | "capturing"
  | "review"
  /** A verified success that cannot be applied → NEEDS_REFUND (refund requested). */
  | "needs_refund"
  | "failed"
  | "canceled"
  | "expired"
  /** Deferred: another finalizer holds the claim, or the provider was unavailable. */
  | "deferred"
  | "config_drift";

export interface FinalizeResult {
  attemptId: string;
  outcome: FinalizeOutcome;
  attemptStatus: AttemptStatus;
  orderStatus: OrderStatus;
}

export interface FinalizeOptions {
  trigger: FinalizeTrigger;
  db?: DbOrTx;
}

export async function finalizeAttempt(
  _attemptId: string,
  _opts: FinalizeOptions,
): Promise<ServiceResult<FinalizeResult>> {
  return notImplemented("finalizeAttempt", "M2");
}
