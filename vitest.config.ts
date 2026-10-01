import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest 5 projects (spec §10.1–10.3):
 * - `unit` and `contract`: pure Node, no database (`npm test`).
 * - `integration`: real Postgres at TEST_DATABASE_URL (local only). `globalSetup` drops and
 *   re-migrates the test database once per run; `setupFiles` pins a fixed test environment so
 *   `src/server/env.ts` parses the same way on every machine; files run one at a time
 *   (`fileParallelism: false`) and tests truncate between cases (`tests/helpers/db.ts`).
 * `server-only` is aliased to an empty module so domain services run directly (spec §2.2).
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": r("./src"),
      "server-only": r("./tests/stubs/server-only.ts"),
    },
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/contract/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
