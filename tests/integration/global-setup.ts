/**
 * Integration global setup (spec §9.1 step 14): once per `vitest --project integration` run,
 * drop and re-migrate the database at TEST_DATABASE_URL. Refuses non-local hosts. The schema is
 * rebuilt from `drizzle/` every run, so a stale or hand-edited test database never hides a
 * migration problem. Tests then truncate between cases (`cleanDatabaseBeforeEach()`).
 */
import { migrateDatabase } from "../../scripts/lib/migrate";
import { newClient, testDatabaseUrl } from "../helpers/db";

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const client = await newClient("geula-tests-setup").catch((error) => {
    throw new Error(
      `cannot connect to TEST_DATABASE_URL (${new URL(url).pathname.slice(1)}); run \`npm run db:setup\` first`,
      { cause: error },
    );
  });
  try {
    await client.query("SET client_min_messages TO WARNING");
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}
