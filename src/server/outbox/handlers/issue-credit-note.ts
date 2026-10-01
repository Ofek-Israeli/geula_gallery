import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { JobHandler } from "../types";

/**
 * `ISSUE_CREDIT_NOTE` handler (spec §5.4). M1 stub: the processor treats the thrown error like any failure
 * (backoff, DEAD after 8 attempts). Owner: WS2.
 *
 * Issue the credit note for a settled refund. While the receipt is ISSUING or UNKNOWN return
 * `{ kind: 'reschedule' }`; NEEDS_MANUAL only when the receipt ends FAILED or NEEDS_MANUAL (spec §4.3).
 * Must be idempotent: a job can run more than once (lease expiry, retries).
 */
export const issueCreditNoteHandler: JobHandler<"ISSUE_CREDIT_NOTE"> = async (
  _payload,
  _ctx,
) => notImplemented("outbox handler ISSUE_CREDIT_NOTE", "WS2");
