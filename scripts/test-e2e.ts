/**
 * `npm run test:e2e [-- <playwright args>]` — runs `playwright test` (spec §10.4).
 * playwright.config.ts starts its own production server on E2E_PORT with a pinned environment
 * (db:reset of the E2E database, `next build` into `.next-e2e`, `next start`).
 */
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "npx",
  ["playwright", "test", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
