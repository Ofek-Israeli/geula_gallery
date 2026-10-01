/**
 * `npm run db:migrate [-- --db <name>]`
 *
 * Applies the committed SQL migrations in ./drizzle with the drizzle node-postgres migrator.
 * Uses DATABASE_URL_UNPOOLED ?? DATABASE_URL (Neon: the unpooled URL), so it also runs in the
 * deploy build (`npm run db:migrate && next build`). `--db <name>` targets another database on the
 * same server and is allowed only for local hosts.
 */
import {
  argValue,
  assertLocal,
  dbNameOf,
  requireEnv,
  withDatabase,
} from "./lib/db";
import { migrateDatabase } from "./lib/migrate";

const args = process.argv.slice(2);
const base =
  process.env.DATABASE_URL_UNPOOLED?.trim() || requireEnv("DATABASE_URL");
const dbArg = argValue(args, "--db");
let url = base;
if (dbArg) {
  assertLocal(base, "db:migrate");
  url = withDatabase(base, dbArg);
}
await migrateDatabase(url);
console.log(`[db:migrate] ${dbNameOf(url)}: migrations applied`);
