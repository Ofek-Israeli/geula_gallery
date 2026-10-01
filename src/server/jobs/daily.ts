import "server-only";
import { log } from "@/server/log";
import type { CronJob } from "./index";

/**
 * `daily` cron job, schedule `0 5 * * *` UTC (spec §5.11). M1 stub; owner: WS6 (Cardcom tail and live sweep: WS2).
 *
 * Cardcom tail polling and live ListTransactions sweep; deadline alerts; COMPLETED transitions;
 * checkInvariants() (Tier B); go-live digest (spec §5.11).
 *
 * Contract: idempotent; stop starting new items once `ctx.expired()`; at most
 * `PROVIDER_CONCURRENCY` provider calls in flight (`forEachWithinBudget`); return counters.
 */
export const dailyJob: CronJob = async (ctx) => {
  log.info("cron.stub", { job: ctx.job });
  return { notImplemented: true };
};
