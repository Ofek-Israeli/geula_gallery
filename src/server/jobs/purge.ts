import "server-only";
import { log } from "@/server/log";
import type { CronJob } from "./index";

/**
 * `purge` cron job, schedule `30 2 * * *` UTC (spec §5.11). M1 stub; owner: WS6.
 *
 * Retention per spec §7 (expired orders anonymised after 30 days, email html after 30 days,
 * payment event payloads after 180 days, rate_limits after 2 days, mock_payments after 30 days, …).
 *
 * Contract: idempotent; stop starting new items once `ctx.expired()`; at most
 * `PROVIDER_CONCURRENCY` provider calls in flight (`forEachWithinBudget`); return counters.
 */
export const purgeJob: CronJob = async (ctx) => {
  log.info("cron.stub", { job: ctx.job });
  return { notImplemented: true };
};
