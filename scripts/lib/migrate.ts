import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { withClient } from "./db";

/** Apply the committed SQL migrations in ./drizzle (drizzle node-postgres migrator). */
export async function migrateDatabase(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query("SET client_min_messages TO WARNING");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });
}
