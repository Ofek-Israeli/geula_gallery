import "server-only";
import { log } from "@/server/log";
import { type Db, db as defaultDb, type Tx } from "./client";

/** Deadlock and serialization failures are retried (spec §2.2 "Transactions and locking"). */
const RETRYABLE = new Set(["40P01", "40001"]);
export const WITH_TX_MAX_ATTEMPTS = 3;

function sqlState(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface WithTxOptions {
  db?: Db;
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  /** For logs only. */
  name?: string;
}

/**
 * Runs `fn` in a transaction and retries it (up to 3 attempts in total) on SQLSTATE 40P01
 * (deadlock) and 40001 (serialization failure). `fn` must use `tx` for every query, must not call
 * providers, and must be safe to re-run from the start.
 */
export async function withTx<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: WithTxOptions = {},
): Promise<T> {
  const database = opts.db ?? defaultDb;
  for (let attempt = 1; ; attempt++) {
    try {
      return await database.transaction(fn, {
        ...(opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : {}),
      });
    } catch (error) {
      const code = sqlState(error);
      if (!code || !RETRYABLE.has(code) || attempt >= WITH_TX_MAX_ATTEMPTS) {
        throw error;
      }
      log.warn("db.tx_retry", { name: opts.name, code, attempt });
      await new Promise((r) =>
        setTimeout(r, 10 * attempt + Math.random() * 20),
      );
    }
  }
}
