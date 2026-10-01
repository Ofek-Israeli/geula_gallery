import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { raiseAlert } from "@/server/alerts/service";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { outboxJobs } from "@/server/db/schema";
import { log } from "@/server/log";
import { outboxHandlers } from "./registry";
import {
  backoffMs,
  type JobHandlerRegistry,
  type JobKind,
  jobPayloadSchemas,
  LEASE_MS,
  MAX_ATTEMPTS,
  type ProcessOutboxResult,
} from "./types";

/**
 * The outbox processor (spec §5.4). Claims due jobs with `FOR UPDATE SKIP LOCKED`, leases them for
 * 5 minutes, runs each handler outside any transaction, then marks DONE, backs off, reschedules or
 * marks DEAD (after 8 attempts, with a CRITICAL alert). A RUNNING job whose lease expired is
 * claimed again (worker crash). Triggers: `after()` (limit 10), the `outbox` cron job (limit 50),
 * `npm run cron -- outbox`.
 *
 * Every state update is conditional on `(id, status='RUNNING', attempts=<claimed>)`, so a worker
 * whose lease was taken over cannot overwrite the newer claim's result.
 */
interface ClaimedJob {
  id: number;
  kind: JobKind;
  dedupe_key: string;
  payload: unknown;
  attempts: number;
}

export interface ProcessOutboxOptions {
  limit: number;
  /** Epoch ms after which no further job is started (cron budget). */
  deadline?: number;
  db?: DbOrTx;
  handlers?: JobHandlerRegistry;
  now?: () => number;
}

async function claim(db: DbOrTx, limit: number): Promise<ClaimedJob[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    UPDATE outbox_jobs
       SET status = 'RUNNING',
           locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval,
           attempts = attempts + 1,
           updated_at = now()
     WHERE id IN (
       SELECT id FROM outbox_jobs
        WHERE (status = 'PENDING' AND run_after <= now())
           OR (status = 'RUNNING' AND locked_until < now())
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, dedupe_key, payload, attempts`);
  return result.rows
    .map((r) => ({
      id: Number(r.id),
      kind: r.kind as JobKind,
      dedupe_key: String(r.dedupe_key),
      payload: r.payload,
      attempts: Number(r.attempts),
    }))
    .sort((a, b) => a.id - b.id);
}

function errorText(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 2000);
}

const isClaimed = (job: ClaimedJob) =>
  and(
    eq(outboxJobs.id, job.id),
    eq(outboxJobs.status, "RUNNING"),
    eq(outboxJobs.attempts, job.attempts),
  );

export async function processOutbox(
  opts: ProcessOutboxOptions,
): Promise<ProcessOutboxResult> {
  const db = opts.db ?? defaultDb;
  const handlers = opts.handlers ?? outboxHandlers;
  const now = opts.now ?? Date.now;
  const stats: ProcessOutboxResult = {
    claimed: 0,
    done: 0,
    retried: 0,
    rescheduled: 0,
    dead: 0,
    released: 0,
  };
  if (opts.limit <= 0) return stats;

  const jobs = await claim(db, opts.limit);
  stats.claimed = jobs.length;

  for (const [index, job] of jobs.entries()) {
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      // Clean stop: hand the rest back without consuming their attempt.
      for (const rest of jobs.slice(index)) {
        await db
          .update(outboxJobs)
          .set({
            status: "PENDING",
            attempts: sql`${outboxJobs.attempts} - 1`,
            lockedUntil: null,
          })
          .where(isClaimed(rest));
        stats.released++;
      }
      break;
    }
    await runOne(db, handlers, job, stats);
  }
  return stats;
}

async function runOne(
  db: DbOrTx,
  handlers: JobHandlerRegistry,
  job: ClaimedJob,
  stats: ProcessOutboxResult,
): Promise<void> {
  const parsed = jobPayloadSchemas[job.kind]?.safeParse(job.payload);
  if (!parsed?.success) {
    await markDead(db, job, "invalid payload");
    stats.dead++;
    return;
  }
  const handler = handlers[job.kind] as (
    payload: unknown,
    ctx: { jobId: number; attempts: number; dedupeKey: string },
  ) => ReturnType<JobHandlerRegistry[JobKind]>;

  try {
    const outcome = await handler(parsed.data, {
      jobId: job.id,
      attempts: job.attempts,
      dedupeKey: job.dedupe_key,
    });
    if (outcome?.kind === "reschedule") {
      await db
        .update(outboxJobs)
        .set({
          status: "PENDING",
          attempts: sql`${outboxJobs.attempts} - 1`,
          runAfter: new Date(Date.now() + Math.max(0, outcome.delayMs)),
          lockedUntil: null,
          lastError: `rescheduled: ${outcome.reason}`.slice(0, 2000),
        })
        .where(isClaimed(job));
      stats.rescheduled++;
      return;
    }
    await db
      .update(outboxJobs)
      .set({
        status: "DONE",
        doneAt: new Date(),
        lockedUntil: null,
        lastError: null,
      })
      .where(isClaimed(job));
    stats.done++;
  } catch (error) {
    log.warn(
      "outbox.job_failed",
      { jobId: job.id, kind: job.kind, attempts: job.attempts },
      error,
    );
    if (job.attempts >= MAX_ATTEMPTS) {
      await markDead(db, job, errorText(error));
      stats.dead++;
      return;
    }
    await db
      .update(outboxJobs)
      .set({
        status: "PENDING",
        runAfter: new Date(Date.now() + backoffMs(job.attempts)),
        lockedUntil: null,
        lastError: errorText(error),
      })
      .where(isClaimed(job));
    stats.retried++;
  }
}

async function markDead(
  db: DbOrTx,
  job: ClaimedJob,
  lastError: string,
): Promise<void> {
  const rows = await db
    .update(outboxJobs)
    .set({ status: "DEAD", lockedUntil: null, lastError })
    .where(isClaimed(job))
    .returning({ id: outboxJobs.id });
  if (rows.length === 0) return;
  await raiseAlert(
    {
      severity: "CRITICAL",
      kind: "OUTBOX_JOB_DEAD",
      dedupeKey: `outbox-dead:${job.id}`,
      entity: "outbox_job",
      entityId: String(job.id),
      params: { kind: job.kind, attempts: job.attempts },
    },
    db,
  );
}

/** Admin "retry" for a DEAD job: back to PENDING with a fresh attempt budget. */
export async function retryDeadJob(
  jobId: number,
  db: DbOrTx = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(outboxJobs)
    .set({
      status: "PENDING",
      attempts: 0,
      runAfter: new Date(),
      lockedUntil: null,
    })
    .where(and(eq(outboxJobs.id, jobId), eq(outboxJobs.status, "DEAD")))
    .returning({ id: outboxJobs.id });
  return rows.length > 0;
}
