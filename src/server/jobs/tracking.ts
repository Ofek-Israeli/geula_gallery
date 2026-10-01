import "server-only";
import type { Db } from "@/server/db/client";
import { pollTracking } from "@/server/shipping/tracking";
import type { CronJob } from "./index";

/**
 * `tracking` cron job, schedule `0 * * * *` UTC (spec §5.11). Owner: WS3.
 *
 * MOCK/DHL shipments in LABEL_CREATED … OUT_FOR_DELIVERY or EXCEPTION tracked > 1 h ago → `track()`
 * → insert events → advance monotonically → one email per new status (spec §5.6). Idempotent;
 * stops starting new items once the budget is spent; at most `PROVIDER_CONCURRENCY` carrier calls
 * in flight.
 */
export const TRACKING_LIMIT = 100;

export const trackingJob: CronJob = async (ctx) =>
  pollTracking({
    limit: TRACKING_LIMIT,
    deadline: ctx.deadline,
    db: ctx.db as Db,
  });
