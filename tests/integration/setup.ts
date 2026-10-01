/**
 * Per-file setup of the `integration` project: pin the fixed test environment before any app
 * module is imported (so `src/server/env.ts` parses `testEnv()`), and close the app pool after
 * the file. Truncation is opt-in per file via `cleanDatabaseBeforeEach()` from `tests/helpers/db.ts`.
 */
import { afterAll } from "vitest";
import { applyTestEnv } from "../helpers/db";

applyTestEnv();

afterAll(async () => {
  const g = globalThis as {
    __geulaPool?: { ended?: boolean; end(): Promise<void> };
  };
  const pool = g.__geulaPool;
  g.__geulaPool = undefined;
  if (pool && !pool.ended) await pool.end();
});
