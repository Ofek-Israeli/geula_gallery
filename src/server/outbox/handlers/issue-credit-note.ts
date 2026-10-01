import "server-only";
import { issueCreditNoteForRefund } from "@/server/taxdocs/issue";
import type { JobHandler } from "../types";

/**
 * `ISSUE_CREDIT_NOTE` handler (spec §5.4, §4.3): the credit note for a settled refund. While the
 * receipt is missing, ISSUING or UNKNOWN it reschedules itself; it becomes NEEDS_MANUAL only when
 * the receipt ended FAILED or NEEDS_MANUAL. Same exactly-once protocol as receipts.
 * Idempotent: a re-run finds the row and continues from its state.
 */
export const issueCreditNoteHandler: JobHandler<"ISSUE_CREDIT_NOTE"> = async (
  payload,
) => {
  const { result } = await issueCreditNoteForRefund(payload.refundId);
  if (result.kind === "reschedule") {
    return {
      kind: "reschedule",
      delayMs: result.delayMs,
      reason: result.reason,
    };
  }
  return { kind: "done" };
};
