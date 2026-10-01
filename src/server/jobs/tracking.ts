import "server-only";
import { log } from "@/server/log";
import type { CronJob } from "./index";

/**
 * `tracking` cron job, schedule `0 * * * *` UTC (spec §5.11). M1 stub; owner: WS3.
 *
 * MOCK/DHL shipments in LABEL_CREATED … OUT_FOR_DELIVERY or EXCEPTION tracked > 1 h ago → `track()`
 * → insert events → advance monotonically → one email per new status (spec §5.6).
 *
 * Contract: idempotent; stop starting new items once `ctx.expired()`; at most
 * `PROVIDER_CONCURRENCY` provider calls in flight (`forEachWithinBudget`); return counters.
 */
export const trackingJob: CronJob = async (ctx) => {
  log.info("cron.stub", { job: ctx.job });
  return { notImplemented: true };
};
