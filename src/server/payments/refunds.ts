import "server-only";
import type { DbOrTx } from "@/server/db/client";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";
import type { RefundStatus } from "@/server/domain/state-machines";

/**
 * Two-phase refunds (spec §5.7 step 8; frozen contract). `requestRefund` inserts REQUESTED under
 * the cap (captured − Σ rows except FAILED-with-failure_confirmed_at ≥ amount) and enqueues
 * `refund:<id>`; `executeRefund` claims REQUESTED → IN_FLIGHT, commits, calls the provider
 * outside any transaction and records SUCCEEDED / PROVIDER_PENDING / MANUAL_REQUIRED / UNKNOWN /
 * FAILED. It never calls the provider for a row it did not move from REQUESTED itself.
 * Bodies: M2 commerce lead.
 */
export type RefundReason =
  | "CANCELLATION"
  | "LOST_RESERVATION"
  | "DUPLICATE_PAYMENT"
  | "ORDER_CANCELLED"
  | "STALE_QUOTE"
  | "AMOUNT_MISMATCH"
  | "ADMIN"
  | "EXTERNAL";

export interface RequestRefundInput {
  attemptId: string;
  amountMinor: number;
  reason: RefundReason;
  cancellationId?: string;
  /** Audit actor (`admin:<id>`, `system`). */
  requestedBy: string;
  /** Legal deadline (cancellations: received + 14 days). */
  legalDueAt?: Date;
  feeWithheldMinor?: number;
}

export async function requestRefund(
  _input: RequestRefundInput,
  _db?: DbOrTx,
): Promise<ServiceResult<{ refundId: string }>> {
  return notImplemented("requestRefund", "M2");
}

export async function executeRefund(
  _refundId: string,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  return notImplemented("executeRefund", "M2");
}

/** MANUAL_REQUIRED → MANUAL_DONE with the reference the admin copied from the dashboard. */
export async function confirmManualRefund(
  _refundId: string,
  _reference: string,
  _ctx: AdminContext,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  return notImplemented("confirmManualRefund", "M2");
}

/** Sets `failure_confirmed_at` on a FAILED row (it stops counting toward the cap). */
export async function confirmRefundFailure(
  _refundId: string,
  _ctx: AdminContext,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  return notImplemented("confirmRefundFailure", "M2");
}
