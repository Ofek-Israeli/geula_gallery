/**
 * Seed registry (spec §8.4; the module list is frozen at contracts-v1).
 *
 *   npm run db:seed [-- --db <name>] [--seed demo|fixtures|none]
 *   npm run prod:seed        (= --remote --yes, with .env.production.local)
 *
 * `db:reset` calls `runSeeds()` after migrating. Every module is idempotent and none enqueues
 * outbox jobs. Mode `none` runs only baseline configuration (settings); `demo` (default) also
 * seeds the painter's catalog (every work available, no invented sales) and admin users;
 * `fixtures` seeds only the 16 fixture works the test suites rely on, with their commerce roles
 * (on hold, not for sale, the three sample orders).
 *
 * A remote database (production) is refused unless `--remote --yes` is given; it then gets only
 * the settings and the painter's catalog (never fixtures, sample orders or users). The images go to
 * a local folder (`--storage-dir`, default `.data/prod-seed`) that `npm run prod:upload` copies to
 * the Blob stores under the same keys.
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
  if (value === "none" || value === "fixtures") return value;
  console.error(
    `[seed] unknown --seed "${value}" (expected demo | fixtures | none)`,
  );
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
    storageDriver: v("STORAGE_DRIVER") ?? "local",
    storageDir: v("LOCAL_STORAGE_DIR") ?? ".data/uploads",
  };
}

/** The modules a remote (production) seed runs: configuration and the painter's catalog. */
export const REMOTE_SEED_MODULES = ["settings", "catalog"] as const;

export async function runSeeds(
  url: string,
  mode: SeedMode,
  env: SeedEnv = readSeedEnv(),
  only?: readonly string[],
): Promise<void> {
  await withClient(url, async (client) => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    for (const mod of seedModules) {
      if (!mod.modes.includes(mode)) continue;
      if (only && !only.includes(mod.name)) continue;
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
  if (args.includes("--remote")) {
    await seedRemote(args);
  } else {
    const base = requireEnv("DATABASE_URL");
    assertLocal(base, "db:seed");
    const dbArg = argValue(args, "--db");
    const url = dbArg ? withDatabase(base, dbArg) : base;
    const mode = parseSeedMode(argValue(args, "--seed"));
    await runSeeds(url, mode);
    console.log(`[db:seed] ${dbNameOf(url)}: seeded (${mode})`);
  }
}

/** `--remote --yes`: the production database (direct URL), settings and the catalog only. */
async function seedRemote(args: string[]): Promise<void> {
  if (!args.includes("--yes")) {
    console.error(
      "[db:seed] --remote writes to a remote (production) database; add --yes to confirm.",
    );
    process.exit(1);
  }
  if (argValue(args, "--db") || argValue(args, "--seed")) {
    console.error(
      "[db:seed] --remote seeds the settings and the painter's catalog only (no --db or --seed).",
    );
    process.exit(1);
  }
  const url =
    process.env.DATABASE_URL_UNPOOLED?.trim() || requireEnv("DATABASE_URL");
  const storageDir = argValue(args, "--storage-dir") ?? ".data/prod-seed";
  await runSeeds(
    url,
    "demo",
    { ...readSeedEnv(), storageDriver: "local", storageDir },
    REMOTE_SEED_MODULES,
  );
  console.log(
    `[db:seed] ${new URL(url).hostname}/${dbNameOf(url)}: settings and catalog seeded; images in ${storageDir} (next: npm run prod:upload)`,
  );
}
