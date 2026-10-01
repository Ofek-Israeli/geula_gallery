/**
 * `npm run admin:create [-- --db <name>]`
 *
 * Creates the painter's admin account from ADMIN_EMAIL / ADMIN_PASSWORD (read from .env.local).
 * Idempotent by email, refuses a fourth user, never prints the password (spec §8.4).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
import {
  argValue,
  dbNameOf,
  isLocalUrl,
  requireEnv,
  withClient,
  withDatabase,
} from "./lib/db";
import { readSeedEnv } from "./seed/index";
import { createAdminUser, MAX_ADMIN_USERS } from "./seed/users";

const args = process.argv.slice(2);
const base = requireEnv("DATABASE_URL");
const dbArg = argValue(args, "--db");
if (dbArg && !isLocalUrl(base)) {
  console.error("[admin:create] --db is only allowed for local databases.");
  process.exit(1);
}
const url = dbArg ? withDatabase(base, dbArg) : base;
const email = requireEnv("ADMIN_EMAIL");
const password = requireEnv("ADMIN_PASSWORD");
if (password.length < 12) {
  console.error(
    "[admin:create] ADMIN_PASSWORD must be at least 12 characters.",
  );
  process.exit(1);
}
const env = readSeedEnv();
if (!env.betterAuthSecret) requireEnv("BETTER_AUTH_SECRET");

try {
  const result = await withClient(url, (client) =>
    createAdminUser(
      drizzle(client, { schema, casing: "snake_case" }),
      { email, password, name: "Painter" },
      env,
    ),
  );
  console.log(
    result === "created"
      ? `[admin:create] created admin ${email} in ${dbNameOf(url)} (password from .env.local; not printed)`
      : `[admin:create] admin ${email} already exists in ${dbNameOf(url)}; nothing to do`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[admin:create] failed: ${message} (max ${MAX_ADMIN_USERS} users)`,
  );
  process.exit(1);
}
