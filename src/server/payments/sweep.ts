import "server-only";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { raiseAlert } from "@/server/alerts/service";
import { type Db, db as defaultDb } from "@/server/db/client";
import { paymentAttempts } from "@/server/db/schema";
import { env as defaultEnv, type Env } from "@/server/env";
import { type CronJobContext, forEachWithinBudget } from "@/server/jobs/index";
import { log } from "@/server/log";
import { finalizeAttempt } from "./finalize";
import { buildProvider } from "./registry";
import type { PaymentProvider } from "./types";

/**
 * Cardcom daily checks (spec §5.3 #10, §5.11 `daily`; owner WS2, called by WS6's `jobs/daily.ts`):
 *
 * - **Tail polling.** A Cardcom attempt that expired unpaid keeps `tail_until = created + 30 days`
 *   (`CARDCOM_TAIL_DAYS`); once a day each one is re-queried through the one `finalizeAttempt()`
 *   (a late payment is applied, or refunded when the work is gone).
 * - **Live sweep** (live mode with an ApiPassword): `listTransactions` for the last 3 days; each
 *   transaction is matched to an attempt by transaction id, ReturnValue (our attempt id) or
 *   LowProfile id. A matched attempt that is not applied yet is finalized; an unmatched transaction
 *   raises a CRITICAL alert ("money we cannot place").
 *
 * Both are idempotent (finalize is a compare-and-set; alerts dedupe by transaction), stop starting
 * work once the cron budget is spent and keep at most `PROVIDER_CONCURRENCY` provider calls in
 * flight.
 */
export type SweepContext = Pick<CronJobContext, "expired" | "deadline">;

export interface SweepDeps {
  db?: Db;
  env?: Env;
  /** The Cardcom adapter (tests pass a fixture adapter; the live gate is then skipped). */
  provider?: PaymentProvider;
  now?: Date;
}

/** An attempt is re-polled at most once per this interval by the tail. */
export const TAIL_POLL_INTERVAL_MS = 20 * 60 * 60_000;
export const TAIL_LIMIT = 100;
export const SWEEP_DAYS = 3;

const APPLIED = new Set(["SUCCEEDED", "NEEDS_REFUND", "REFUNDED"]);

export async function pollCardcomTail(
  ctx: SweepContext,
  deps: SweepDeps = {},
): Promise<{
  due: number;
  processed: number;
  failed: number;
  outcomes: Record<string, number>;
}> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const due = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, "CARDCOM"),
        eq(paymentAttempts.status, "EXPIRED"),
        gt(paymentAttempts.tailUntil, now),
        or(
          isNull(paymentAttempts.lastCheckedAt),
          lt(
            paymentAttempts.lastCheckedAt,
            new Date(now.getTime() - TAIL_POLL_INTERVAL_MS),
          ),
        ),
      ),
    )
    .orderBy(sql`${paymentAttempts.lastCheckedAt} ASC NULLS FIRST`)
    .limit(TAIL_LIMIT);
  const outcomes: Record<string, number> = {};
  const run = await forEachWithinBudget(ctx, due, async ({ id }) => {
    // Stamp first: a provider outage must not make the tail hammer the same attempt.
    await db
      .update(paymentAttempts)
      .set({ lastCheckedAt: now })
      .where(eq(paymentAttempts.id, id));
    const { result } = await finalizeAttempt(id, {
      trigger: "reconcile",
      db,
      ...(deps.env ? { env: deps.env } : {}),
    });
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  });
  return {
    due: due.length,
    processed: run.processed,
    failed: run.failed,
    outcomes,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SweepStats {
  skipped?: "not_live" | "no_api_password" | "no_list_transactions";
  listed: number;
  matched: number;
  alreadyApplied: number;
  finalized: number;
  unmatched: number;
  outcomes: Record<string, number>;
}

export async function sweepCardcomTransactions(
  ctx: SweepContext,
  deps: SweepDeps = {},
): Promise<SweepStats> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const now = deps.now ?? new Date();
  const stats: SweepStats = {
    listed: 0,
    matched: 0,
    alreadyApplied: 0,
    finalized: 0,
    unmatched: 0,
    outcomes: {},
  };
  const provider = deps.provider ?? buildProvider("cardcom", { env: e });
  if (!deps.provider) {
    if (provider?.mode !== "LIVE") {
      return { ...stats, skipped: "not_live" };
    }
    if (!e.CARDCOM_API_PASSWORD)
      return { ...stats, skipped: "no_api_password" };
  }
  if (!provider?.listTransactions) {
    return { ...stats, skipped: "no_list_transactions" };
  }
  const txs = await provider.listTransactions({
    from: new Date(now.getTime() - SWEEP_DAYS * 24 * 60 * 60_000),
    to: now,
  });
  stats.listed = txs.length;

  const toFinalize: string[] = [];
  for (const t of txs) {
    if (ctx.expired()) break;
    const keys = [
      eq(paymentAttempts.transactionId, t.transactionId),
      ...(t.returnValue && UUID_RE.test(t.returnValue)
        ? [eq(paymentAttempts.id, t.returnValue)]
        : []),
      ...(t.lowProfileId
        ? [eq(paymentAttempts.providerRef, t.lowProfileId)]
        : []),
    ];
    const [attempt] = await db
      .select({ id: paymentAttempts.id, status: paymentAttempts.status })
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.provider, "CARDCOM"), or(...keys)))
      .limit(1);
    if (!attempt) {
      stats.unmatched += 1;
      log.error("payments.cardcom_unmatched_transaction", {
        transactionId: t.transactionId,
      });
      await raiseAlert(
        {
          severity: "CRITICAL",
          kind: "UNMATCHED_CARDCOM_TRANSACTION",
          dedupeKey: `cardcom-unmatched:${t.transactionId}`,
          entity: "payment_attempt",
          params: {
            transactionId: t.transactionId,
            amountMinor: t.amount.amountMinor,
            currency: t.amount.currency,
          },
        },
        db,
      );
      continue;
    }
    stats.matched += 1;
    if (APPLIED.has(attempt.status)) stats.alreadyApplied += 1;
    else toFinalize.push(attempt.id);
  }

  const run = await forEachWithinBudget(
    ctx,
    [...new Set(toFinalize)],
    async (id) => {
      const { result } = await finalizeAttempt(id, {
        trigger: "reconcile",
        db,
        ...(deps.env ? { env: deps.env } : {}),
      });
      stats.outcomes[result.outcome] =
        (stats.outcomes[result.outcome] ?? 0) + 1;
    },
  );
  stats.finalized = run.processed;
  return stats;
}

/** Both checks, for WS6's `daily` job: `{ cardcomTail, cardcomSweep }` go into its stats. */
export async function runCardcomDailyChecks(
  ctx: SweepContext,
  deps: SweepDeps = {},
): Promise<{
  cardcomTail: Awaited<ReturnType<typeof pollCardcomTail>>;
  cardcomSweep: SweepStats;
}> {
  const cardcomTail = await pollCardcomTail(ctx, deps);
  const cardcomSweep = ctx.expired()
    ? {
        listed: 0,
        matched: 0,
        alreadyApplied: 0,
        finalized: 0,
        unmatched: 0,
        outcomes: {},
      }
    : await sweepCardcomTransactions(ctx, deps);
  return { cardcomTail, cardcomSweep };
}
