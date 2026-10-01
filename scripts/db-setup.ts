/**
 * `npm run db:setup [-- --db <name> ...]`
 *
 * Creates the local databases if they do not exist: the databases named by DATABASE_URL,
 * TEST_DATABASE_URL and E2E_DATABASE_URL (geula_dev / geula_test / geula_e2e by default), plus any
 * extra `--db <name>` (per-worktree databases, e.g. geula_dev_ws2). Uses `pg` directly, so psql
 * does not need to be on PATH. Refuses non-localhost hosts (spec §8.1).
 */
import {
  assertDbName,
  assertLocal,
  dbNameOf,
  quoteIdent,
  requireEnv,
  withClient,
  withDatabase,
} from "./lib/db";

const args = process.argv.slice(2);
const baseUrl = requireEnv("DATABASE_URL");
assertLocal(baseUrl, "db:setup");

const names = new Set<string>([dbNameOf(baseUrl)]);
for (const key of ["TEST_DATABASE_URL", "E2E_DATABASE_URL"] as const) {
  const url = process.env[key]?.trim();
  if (url) {
    assertLocal(url, "db:setup");
    names.add(dbNameOf(url));
  }
}
if (!process.env.TEST_DATABASE_URL) names.add("geula_test");
if (!process.env.E2E_DATABASE_URL) names.add("geula_e2e");
args.forEach((arg, i) => {
  if (arg === "--db" && args[i + 1]) names.add(args[i + 1] as string);
  else if (arg.startsWith("--db=")) names.add(arg.slice("--db=".length));
});

await withClient(withDatabase(baseUrl, "postgres"), async (client) => {
  for (const name of names) {
    assertDbName(name);
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (rowCount) {
      console.log(`[db:setup] ${name}: exists`);
    } else {
      await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
      console.log(`[db:setup] ${name}: created`);
    }
  }
});
