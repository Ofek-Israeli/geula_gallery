import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { JobHandler } from "../types";

/**
 * `REFUND_PAYMENT` handler (spec §5.4). M1 stub: the processor treats the thrown error like any failure
 * (backoff, DEAD after 8 attempts). Owner: WS2 (M2: refunds.ts).
 *
 * Calls `payments/refunds.ts#executeRefund(refundId)`: claim REQUESTED → IN_FLIGHT, call the provider
 * outside the transaction, record the result (spec §5.7 step 8).
 * Must be idempotent: a job can run more than once (lease expiry, retries).
 */
export const refundPaymentHandler: JobHandler<"REFUND_PAYMENT"> = async (
  _payload,
  _ctx,
) => notImplemented("outbox handler REFUND_PAYMENT", "WS2 (M2: refunds.ts)");
