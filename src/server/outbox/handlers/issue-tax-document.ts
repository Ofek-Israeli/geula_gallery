import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { JobHandler } from "../types";

/**
 * `ISSUE_TAX_DOCUMENT` handler (spec §5.4). M1 stub: the processor treats the thrown error like any failure
 * (backoff, DEAD after 8 attempts). Owner: WS2 (M2: mock tax documents).
 *
 * Issue the receipt for a captured attempt exactly once: claim row (ISSUING, marker) → provider →
 * ISSUED / UNKNOWN / FAILED; UNKNOWN is resolved by `findByMarker` first (spec §4.3).
 * Must be idempotent: a job can run more than once (lease expiry, retries).
 */
export const issueTaxDocumentHandler: JobHandler<"ISSUE_TAX_DOCUMENT"> = async (
  _payload,
  _ctx,
) =>
  notImplemented(
    "outbox handler ISSUE_TAX_DOCUMENT",
    "WS2 (M2: mock tax documents)",
  );
