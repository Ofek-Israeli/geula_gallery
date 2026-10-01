/**
 * Concurrency helpers for integration tests (spec §10.3 `reserve-race`, `finalize`,
 * `capture-race`; frozen at contracts-v1).
 *
 * `race(n, fn)` opens `n` **dedicated** `pg.Client`s (never the app pool, whose size would
 * serialise the contenders), connects them all, releases them together through a barrier and
 * returns every outcome (`Promise.allSettled` shape). Each contender gets its own Drizzle
 * instance over its client, so services that accept a `DbOrTx` run on separate connections.
 *
 * `deadlockCount()` reads `pg_stat_database.deadlocks` for the test database (compare before and
 * after), and `watchLockWaits()` samples `pg_stat_activity` for sessions waiting on a lock.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { newClient } from "./db";

/** A reusable N-party barrier: `wait()` resolves once `parties` callers are waiting. */
export function createBarrier(parties: number): { wait(): Promise<void> } {
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    wait() {
      waiting += 1;
      if (waiting >= parties) release();
      return gate;
    },
  };
}

export interface Contender {
  index: number;
  client: pg.Client;
  /** Drizzle over this contender's own connection (typed as the app `Db` for service calls). */
  db: Db;
}

/** Drizzle over a dedicated client, typed as the app `Db` (same query API; `$client` differs). */
export function drizzleFor(client: pg.Client): Db {
  return drizzle(client, { schema, casing: "snake_case" }) as unknown as Db;
}

/**
 * Run `fn` on `n` dedicated connections released at the same instant. Clients are always closed.
 */
export async function race<T>(
  n: number,
  fn: (c: Contender) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const clients = await Promise.all(
    Array.from({ length: n }, (_, i) => newClient(`geula-race-${i}`)),
  );
  const barrier = createBarrier(n);
  try {
    return await Promise.allSettled(
      clients.map(async (client, index) => {
        await barrier.wait();
        return fn({ index, client, db: drizzleFor(client) });
      }),
    );
  } finally {
    await Promise.allSettled(clients.map((c) => c.end()));
  }
}

/** Split settled results into values and reasons. */
export function partition<T>(results: PromiseSettledResult<T>[]): {
  fulfilled: T[];
  rejected: unknown[];
} {
  const fulfilled: T[] = [];
  const rejected: unknown[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") fulfilled.push(r.value);
    else rejected.push(r.reason);
  }
  return { fulfilled, rejected };
}

/** `pg_stat_database.deadlocks` for the current database (statistics may lag ~ms; flushes first). */
export async function deadlockCount(): Promise<number> {
  const client = await newClient("geula-race-stats");
  try {
    await client.query("SELECT pg_stat_force_next_flush()").catch(() => {});
    await client.query("SELECT pg_stat_clear_snapshot()");
    const res = await client.query<{ deadlocks: string }>(
      "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
    );
    return Number(res.rows[0]?.deadlocks ?? 0);
  } finally {
    await client.end();
  }
}

/**
 * Poll `pg_stat_activity` every `intervalMs` for sessions of this database waiting on a heavyweight
 * lock. `stop()` returns the maximum number of simultaneous waiters seen.
 */
export async function watchLockWaits(
  intervalMs = 2,
): Promise<{ stop(): Promise<number> }> {
  const client = await newClient("geula-race-watch");
  let max = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const res = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      max = Math.max(max, Number(res.rows[0]?.n ?? 0));
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      await client.end();
      return max;
    },
  };
}
