import "server-only";
import { log } from "@/server/log";
import type { CronJob } from "./index";

/**
 * `reconcile` cron job, every 5 minutes (spec §5.11). M1 stub; owner: M2 (commerce lead), then WS2.
 *
 * (1) replay unprocessed payment_events (2 min – 3 days old, ≤ 20); (2) finalize attempts due by
 * `next_check_at` (PENDING, AWAITING_CAPTURE, CAPTURING, PAYMENT_REVIEW, deferred) with the
 * backoff ladder; (3) refunds PROVIDER_PENDING/UNKNOWN → getRefund, expired IN_FLIGHT leases →
 * UNKNOWN; (4) expire AWAITING_PAYMENT orders past `expires_at` with no in-flight attempt.
 *
 * Contract: idempotent; stop starting new items once `ctx.expired()`; at most
 * `PROVIDER_CONCURRENCY` provider calls in flight (`forEachWithinBudget`); return counters.
 */
export const reconcileJob: CronJob = async (ctx) => {
  log.info("cron.stub", { job: ctx.job });
  return { notImplemented: true };
};
