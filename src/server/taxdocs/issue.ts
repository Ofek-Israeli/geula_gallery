import "server-only";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";
import type { TaxDocumentStatus } from "@/server/domain/state-machines";

/**
 * The tax-document pipeline (spec §4.3 "Which payments get a receipt", "Exactly once",
 * "Credit-note handler"). Called by the `ISSUE_TAX_DOCUMENT` / `ISSUE_CREDIT_NOTE` outbox handlers.
 * - Receipts: every SUCCEEDED attempt, and NEEDS_REFUND attempts other than AMOUNT_MISMATCH (unless
 *   `settings.checkout.receiptForRefundedPayments` is off).
 * - Claim row ISSUING + marker before the call; timeout/5xx → UNKNOWN; retry (≥ 5 min) runs
 *   `findByMarker` first; 3 inconclusive searches → NEEDS_MANUAL + alert; clear 4xx → FAILED.
 * - Credit notes reschedule while the receipt is ISSUING/UNKNOWN.
 * Bodies: M2 (mock) and WS2.
 */
export type IssueOutcome =
  | { kind: "issued"; taxDocumentId: string; status: TaxDocumentStatus }
  | { kind: "skipped"; reason: "not_eligible" | "already_issued" | "disabled" }
  | { kind: "reschedule"; delayMs: number; reason: string }
  | { kind: "needs_manual"; taxDocumentId: string };

export async function issueReceiptForAttempt(
  _attemptId: string,
): Promise<ServiceResult<IssueOutcome>> {
  return notImplemented("issueReceiptForAttempt", "M2");
}

export async function issueCreditNoteForRefund(
  _refundId: string,
): Promise<ServiceResult<IssueOutcome>> {
  return notImplemented("issueCreditNoteForRefund", "WS2");
}
