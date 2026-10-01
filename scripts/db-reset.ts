/**
 * `npm run db:reset -- [--db <name>] [--seed demo|none] --yes`
 *
 * Local only (refuses non-localhost hosts): drops the `public` and `drizzle` schemas, re-applies
 * the committed migrations and runs the seed registry (spec §8.4). `--yes` is required because
 * every row in the target database is destroyed.
 */
import {
  argValue,
  assertLocal,
  dbNameOf,
  requireEnv,
  withClient,
  withDatabase,
} from "./lib/db";
import { migrateDatabase } from "./lib/migrate";
import { parseSeedMode, runSeeds } from "./seed/index";

const args = process.argv.slice(2);
const base = requireEnv("DATABASE_URL");
assertLocal(base, "db:reset");
const dbArg = argValue(args, "--db");
const url = dbArg ? withDatabase(base, dbArg) : base;
assertLocal(url, "db:reset");
const mode = parseSeedMode(argValue(args, "--seed"));
const name = dbNameOf(url);

if (!args.includes("--yes")) {
  console.error(
    `[db:reset] this drops every table in "${name}". Re-run with --yes to confirm:\n  npm run db:reset -- --yes`,
  );
  process.exit(1);
}

await withClient(url, async (client) => {
  await client.query("SET client_min_messages TO WARNING");
  await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
});
console.log(`[db:reset] ${name}: schemas dropped`);

await migrateDatabase(url);
console.log(`[db:reset] ${name}: migrations applied`);

await runSeeds(url, mode);
console.log(`[db:reset] ${name}: seeded (${mode})`);
