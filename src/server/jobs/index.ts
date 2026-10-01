import "server-only";
import { eq } from "drizzle-orm";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { cronRuns } from "@/server/db/schema";
import { log } from "@/server/log";
import { redact } from "@/server/security/redact";

/**
 * Cron jobs (spec §5.11, §9.3 frozen). Five jobs, each idempotent, each with a wall-clock budget,
 * each recording a `cron_runs` row. Triggered by `GET /api/cron/<job>` (Vercel Cron, or
 * `npm run cron -- <job>` locally). Job modules are loaded lazily so a run only imports what it
 * needs. Streams replace the bodies of their own job files and never edit this registry.
 */
export const CRON_JOBS = [
  "reconcile",
  "outbox",
  "tracking",
  "daily",
  "purge",
] as const;
export type CronJobName = (typeof CRON_JOBS)[number];

export function isCronJobName(value: string): value is CronJobName {
  return (CRON_JOBS as readonly string[]).includes(value);
}

/** Vercel functions get 60 s (`maxDuration`); jobs stop starting work after 50 s. */
export const CRON_BUDGET_MS = 50_000;
/** At most this many provider calls in flight per job (spec §5.11). */
export const PROVIDER_CONCURRENCY = 3;

export type CronStats = Record<string, unknown>;

export interface CronJobContext {
  job: CronJobName;
  startedAt: Date;
  /** Epoch ms after which no new item is started. */
  deadline: number;
  remainingMs(): number;
  expired(): boolean;
  db: DbOrTx;
}

export type CronJob = (ctx: CronJobContext) => Promise<CronStats>;

const JOB_MODULES: Record<CronJobName, () => Promise<CronJob>> = {
  reconcile: async () => (await import("./reconcile")).reconcileJob,
  outbox: async () => (await import("./outbox")).outboxJob,
  tracking: async () => (await import("./tracking")).trackingJob,
  daily: async () => (await import("./daily")).dailyJob,
  purge: async () => (await import("./purge")).purgeJob,
};

export interface CronRunResult {
  job: CronJobName;
  runId: string;
  ok: boolean;
  durationMs: number;
  stats: CronStats;
  error?: string;
}

export async function runCronJob(
  job: CronJobName,
  opts: { db?: DbOrTx; budgetMs?: number; now?: () => number } = {},
): Promise<CronRunResult> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + (opts.budgetMs ?? CRON_BUDGET_MS);
  const [run] = await db
    .insert(cronRuns)
    .values({ job, startedAt: new Date(started) })
    .returning({ id: cronRuns.id });
  if (!run) throw new Error("cron_runs insert returned no row");

  const ctx: CronJobContext = {
    job,
    startedAt: new Date(started),
    deadline,
    remainingMs: () => Math.max(0, deadline - now()),
    expired: () => now() >= deadline,
    db,
  };

  let ok = true;
  let stats: CronStats = {};
  let error: string | undefined;
  try {
    const fn = await JOB_MODULES[job]();
    stats = await fn(ctx);
  } catch (e) {
    ok = false;
    error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(
      0,
      2000,
    );
    log.error("cron.job_failed", { job, runId: run.id }, e);
  }
  const durationMs = now() - started;
  await db
    .update(cronRuns)
    .set({
      finishedAt: new Date(),
      ok,
      stats: redact({ ...stats, durationMs }),
      error: error ?? null,
    })
    .where(eq(cronRuns.id, run.id));
  return {
    job,
    runId: run.id,
    ok,
    durationMs,
    stats,
    ...(error ? { error } : {}),
  };
}

/**
 * Runs `fn` over `items` with at most `concurrency` in flight, starting nothing once the budget is
 * spent. Returns how many items were processed and how many were left for the next run.
 */
export async function forEachWithinBudget<T>(
  ctx: Pick<CronJobContext, "expired">,
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  concurrency: number = PROVIDER_CONCURRENCY,
): Promise<{ processed: number; skipped: number; failed: number }> {
  let next = 0;
  let processed = 0;
  let failed = 0;
  const worker = async () => {
    while (next < items.length && !ctx.expired()) {
      const item = items[next++] as T;
      try {
        await fn(item);
        processed++;
      } catch (error) {
        failed++;
        log.warn("cron.item_failed", {}, error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      worker,
    ),
  );
  return { processed, skipped: items.length - processed - failed, failed };
}
