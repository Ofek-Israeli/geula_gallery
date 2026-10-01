import "server-only";
import { executeRefund } from "@/server/payments/refunds";
import type { JobHandler } from "../types";

/**
 * `REFUND_PAYMENT` handler (spec §5.4): `executeRefund(refundId)` claims REQUESTED → IN_FLIGHT,
 * calls the provider outside any transaction and records the result (spec §5.7 step 8).
 * Idempotent: a re-run finds the row past REQUESTED and never calls the provider again. A row
 * another worker holds IN_FLIGHT (live lease) is rescheduled; an expired lease becomes UNKNOWN for
 * the reconcile job.
 */
export const refundPaymentHandler: JobHandler<"REFUND_PAYMENT"> = async (
  payload,
) => {
  const { result } = await executeRefund(payload.refundId);
  if (result.status === "IN_FLIGHT") {
    return {
      kind: "reschedule",
      delayMs: 3 * 60_000,
      reason: "refund in flight in another worker",
    };
  }
  return { kind: "done" };
};
