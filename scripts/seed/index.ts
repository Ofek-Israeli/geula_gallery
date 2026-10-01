/**
 * Seed registry (spec §8.4; the module list is frozen at contracts-v1).
 *
 *   npm run db:seed [-- --db <name>] [--seed demo|none]
 *
 * `db:reset` calls `runSeeds()` after migrating. Every module is idempotent and none enqueues
 * outbox jobs. Mode `none` runs only baseline configuration (settings); `demo` (default) also
 * seeds the demo catalog, sample orders and admin users.
 */
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
import {
  argValue,
  assertLocal,
  dbNameOf,
  requireEnv,
  withClient,
  withDatabase,
} from "../lib/db";
import { catalogSeed } from "./catalog";
import { ordersSeed } from "./orders";
import { settingsSeed } from "./settings";
import type { SeedEnv, SeedMode, SeedModule } from "./types";
import { usersSeed } from "./users";

export type { SeedContext, SeedEnv, SeedMode, SeedModule } from "./types";

export const seedModules: readonly SeedModule[] = [
  settingsSeed,
  catalogSeed,
  ordersSeed,
  usersSeed,
];

export function parseSeedMode(value: string | undefined): SeedMode {
  if (value === undefined || value === "demo") return "demo";
  if (value === "none") return "none";
  console.error(`[seed] unknown --seed "${value}" (expected demo | none)`);
  process.exit(1);
}

export function readSeedEnv(): SeedEnv {
  const v = (k: string) => process.env[k]?.trim() || undefined;
  return {
    adminEmail: v("ADMIN_EMAIL"),
    adminPassword: v("ADMIN_PASSWORD"),
    betterAuthSecret: v("BETTER_AUTH_SECRET"),
    authBaseUrl:
      v("BETTER_AUTH_URL") ?? v("APP_URL") ?? "http://localhost:3000",
    seedE2eUsers: ["1", "true", "yes"].includes(
      (v("SEED_E2E_USERS") ?? "").toLowerCase(),
    ),
    e2eAdminPassword: v("E2E_ADMIN_PASSWORD") ?? "e2e-admin-password",
  };
}

export async function runSeeds(
  url: string,
  mode: SeedMode,
  env: SeedEnv = readSeedEnv(),
): Promise<void> {
  await withClient(url, async (client) => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    for (const mod of seedModules) {
      if (!mod.modes.includes(mode)) continue;
      await mod.run({
        db,
        mode,
        env,
        log: (m) => console.log(`[seed] ${m}`),
      });
    }
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const base = requireEnv("DATABASE_URL");
  assertLocal(base, "db:seed");
  const dbArg = argValue(args, "--db");
  const url = dbArg ? withDatabase(base, dbArg) : base;
  const mode = parseSeedMode(argValue(args, "--seed"));
  await runSeeds(url, mode);
  console.log(`[db:seed] ${dbNameOf(url)}: seeded (${mode})`);
}
