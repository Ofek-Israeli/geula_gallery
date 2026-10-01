import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/server/db/schema";

export type SeedMode = "demo" | "none";
export type SeedDb = NodePgDatabase<typeof schema>;

/** Values the seeds read from the environment (scripts read process.env directly). */
export interface SeedEnv {
  adminEmail?: string;
  adminPassword?: string;
  betterAuthSecret?: string;
  /** BETTER_AUTH_URL ?? APP_URL */
  authBaseUrl: string;
  seedE2eUsers: boolean;
  e2eAdminPassword: string;
  /** STORAGE_DRIVER (default `local`); the demo catalog seed supports `local` only. */
  storageDriver?: string;
  /** LOCAL_STORAGE_DIR (default `.data/uploads`), where the catalog seed writes images. */
  storageDir?: string;
}

export interface SeedContext {
  db: SeedDb;
  mode: SeedMode;
  env: SeedEnv;
  log: (message: string) => void;
}

export type SeedModuleName = "settings" | "catalog" | "orders" | "users";

export interface SeedModule {
  name: SeedModuleName;
  /** Modes in which the module runs. `none` = baseline configuration only, no demo content. */
  modes: readonly SeedMode[];
  /** Must be idempotent (upserts / existence checks). Seeds never enqueue outbox jobs. */
  run: (ctx: SeedContext) => Promise<void>;
}
