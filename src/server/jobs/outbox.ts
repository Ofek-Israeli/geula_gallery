import "server-only";
import { processOutbox } from "@/server/outbox/process";
import type { CronJob } from "./index";

/** Batch size per cron run (spec §5.11: `processOutbox({ limit: 50 })` within the budget). */
export const CRON_OUTBOX_LIMIT = 50;

/** `outbox` cron job, every 5 minutes (spec §5.11). */
export const outboxJob: CronJob = async (ctx) => {
  const result = await processOutbox({
    limit: CRON_OUTBOX_LIMIT,
    deadline: ctx.deadline,
    db: ctx.db,
  });
  return { ...result };
};
