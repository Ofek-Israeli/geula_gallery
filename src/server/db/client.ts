import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/server/env";
import * as schema from "./schema";

/**
 * One pg Pool per process (spec §6.8): cached on globalThis outside production so dev HMR does not
 * leak pools; registered with `attachDatabasePool` in production (Vercel Fluid compute).
 * Use the core query builder only (spec §2.2); `casing: 'snake_case'` maps camelCase keys.
 */
const globalForDb = globalThis as unknown as { __geulaPool?: Pool };

function createPool(): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: env.APP_ENV === "test" ? 4 : 5,
    application_name: "geula-gallery",
  });
}

export const pool: Pool = globalForDb.__geulaPool ?? createPool();
if (env.isProduction) {
  attachDatabasePool(pool);
} else {
  globalForDb.__geulaPool = pool;
}

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the pooled db or a transaction. */
export type DbOrTx = Db | Tx;
