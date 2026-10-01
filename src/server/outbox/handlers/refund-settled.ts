import "server-only";
import { settleRefund } from "@/server/payments/refunds";
import type { JobHandler } from "../types";

/**
 * `REFUND_SETTLED` handler (spec §5.4): in order → attempt → refund lock order, a NEEDS_REFUND
 * attempt → REFUNDED; a cancellation refund → order CANCELLED (from PAID or COMPLETED); the
 * credit-note job; the `refund-issued` email; audit. The refund row is already final, so a failure
 * here is simply retried (spec §5.3 #32). Idempotent: every transition is conditional.
 */
export const refundSettledHandler: JobHandler<"REFUND_SETTLED"> = async (
  payload,
) => {
  await settleRefund(payload.refundId);
  return { kind: "done" };
};
