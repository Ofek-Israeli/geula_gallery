import "server-only";
import { issueReceiptForAttempt } from "@/server/taxdocs/issue";
import type { JobHandler } from "../types";

/**
 * `ISSUE_TAX_DOCUMENT` handler (spec §5.4, §4.3): the receipt for a captured attempt, exactly once
 * (claim row ISSUING + marker → provider → ISSUED / UNKNOWN / FAILED; UNKNOWN is resolved by
 * `findByMarker` first, no sooner than 5 min later). Waiting states reschedule the job without
 * consuming an attempt; FAILED and NEEDS_MANUAL end the job (the admin takes over, with an alert).
 * Idempotent: a re-run finds the row and continues from its state.
 */
export const issueTaxDocumentHandler: JobHandler<"ISSUE_TAX_DOCUMENT"> = async (
  payload,
) => {
  const { result } = await issueReceiptForAttempt(payload.attemptId);
  if (result.kind === "reschedule") {
    return {
      kind: "reschedule",
      delayMs: result.delayMs,
      reason: result.reason,
    };
  }
  return { kind: "done" };
};
