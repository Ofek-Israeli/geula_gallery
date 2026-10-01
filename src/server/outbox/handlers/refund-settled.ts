import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { JobHandler } from "../types";

/**
 * `REFUND_SETTLED` handler (spec §5.4). M1 stub: the processor treats the thrown error like any failure
 * (backoff, DEAD after 8 attempts). Owner: WS2.
 *
 * In order → attempt → refund lock order: NEEDS_REFUND attempt → REFUNDED; a cancellation refund →
 * order CANCELLED (from PAID or COMPLETED); credit-note job; `refund-issued` email; audit (spec §5.4).
 * Must be idempotent: a job can run more than once (lease expiry, retries).
 */
export const refundSettledHandler: JobHandler<"REFUND_SETTLED"> = async (
  _payload,
  _ctx,
) => notImplemented("outbox handler REFUND_SETTLED", "WS2");
