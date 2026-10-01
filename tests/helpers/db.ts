/**
 * Integration-test database helpers (spec §9.3: frozen at contracts-v1; streams add their own
 * factories instead of editing this file).
 *
 * - `testDatabaseUrl()` resolves TEST_DATABASE_URL (shell first, then `.env.local`) and refuses
 *   anything that is not a local Postgres.
 * - `TEST_ENV` is the fixed environment the `integration` project runs with (set by
 *   `tests/integration/setup.ts` before any app module is imported).
 * - `cleanDatabaseBeforeEach()` truncates every application table and re-seeds the baseline settings
 *   before each test. Truncation, not transactions: services open their own transactions and
 *   race tests need committed rows that other connections can see.
 * - `pgErrorCode()` / `expectPgError()` read the SQLSTATE through Drizzle's error wrapper.
 * - `newClient()` opens a dedicated `pg.Client` (never the app pool); close it yourself, or use
 *   `tests/helpers/race.ts`.
 *
 * App modules (`@/server/db/client`, seeds) are imported lazily so that importing this file
 * never parses the app environment (the global setup imports it too).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { beforeEach, expect } from "vitest";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function fromEnvLocal(key: string): string | undefined {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return undefined;
  return parseEnv(readFileSync(file, "utf8"))[key];
}

/** TEST_DATABASE_URL from the shell or `.env.local`; throws unless it is a local database. */
export function testDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL?.trim() ||
    fromEnvLocal("TEST_DATABASE_URL")?.trim();
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set (run `npm run env:init` and `npm run db:setup`).",
    );
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `integration tests refuse to run against non-local host "${host}"`,
    );
  }
  return url;
}

/** base64 of 32 fixed bytes (AES-256-GCM key for tests only). */
const TEST_PII_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * The fixed environment of the `integration` project. Secrets are obviously fake `test-` values;
 * providers are mocks, email is the log driver, storage is local under `.data/test-uploads`.
 */
export function testEnv(): Record<string, string> {
  const dbUrl = testDatabaseUrl();
  return {
    APP_ENV: "test",
    APP_URL: "http://localhost:3000",
    APP_SECRET: "test-app-secret-0123456789abcdef0123456789",
    PII_ENCRYPTION_KEY: TEST_PII_KEY,
    DEMO_MODE: "true",
    DATABASE_URL: dbUrl,
    TEST_DATABASE_URL: dbUrl,
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
    ADMIN_REQUIRE_2FA: "false",
    ADMIN_EMAIL: "painter@example.test",
    SEED_E2E_USERS: "false",
    RATE_LIMIT_SCALE: "1",
    FORM_MIN_AGE_MS: "0",
    CRON_SECRET: "test-cron-secret-0123456789",
    PAYMENT_PROVIDERS: "mock",
    MOCK_WEBHOOK_SECRET: "test-mock-webhook-secret-0123456789",
    MOCK_PAYMENT_FLOW: "direct",
    CARDCOM_MODE: "disabled",
    PAYPAL_MODE: "disabled",
    TAX_DOCUMENTS_MODE: "mock",
    MORNING_MODE: "disabled",
    SHIPPING_CARRIER: "mock",
    DHL_EXPRESS_MODE: "disabled",
    MOCK_CARRIER_DELIVERY_SECONDS: "1",
    EMAIL_DRIVER: "log",
    EMAIL_FROM: "Geula Gallery <studio@example.com>",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: ".data/test-uploads",
  };
}

/** Prefixes cleared from the inherited environment so real credentials never reach tests. */
const SCRUBBED_PREFIXES = [
  "CARDCOM_",
  "PAYPAL_",
  "MORNING_",
  "DHL_",
  "RESEND_",
  "BLOB_",
  "PUBLIC_WEBHOOK_BASE_URL",
  "BETTER_AUTH_URL",
  "DATABASE_URL_UNPOOLED",
  "EMAIL_REPLY_TO",
];

/** Replace the process environment's app keys with `testEnv()` (call before importing app code). */
export function applyTestEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (SCRUBBED_PREFIXES.some((p) => key.startsWith(p))) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, testEnv());
}

/** A dedicated client on the test database (not the app pool). Caller must `end()` it. */
export async function newClient(applicationName = "geula-tests") {
  const client = new pg.Client({
    connectionString: testDatabaseUrl(),
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

/** Tables that survive truncation (migration bookkeeping lives in the `drizzle` schema). */
const KEEP_TABLES = new Set<string>();

let tableList: string[] | null = null;

async function appTables(): Promise<string[]> {
  if (tableList) return tableList;
  const { pool } = await import("@/server/db/client");
  const res = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  tableList = res.rows
    .map((r) => r.tablename)
    .filter((t) => !KEEP_TABLES.has(t));
  return tableList;
}

/** TRUNCATE every application table (RESTART IDENTITY CASCADE). */
export async function truncateAll(): Promise<void> {
  const tables = await appTables();
  if (tables.length === 0) return;
  const { pool } = await import("@/server/db/client");
  const list = tables.map((t) => `"public"."${t.replace(/"/g, '""')}"`);
  await pool.query(`TRUNCATE ${list.join(", ")} RESTART IDENTITY CASCADE`);
}

/** Insert the baseline settings rows (the `settings` seed module, as `db:reset --seed none`). */
export async function seedBaseline(): Promise<void> {
  const [{ db }, { settingsSeed }] = await Promise.all([
    import("@/server/db/client"),
    import("../../scripts/seed/settings"),
  ]);
  await settingsSeed.run({
    db,
    mode: "none",
    env: {
      authBaseUrl: "http://localhost:3000",
      seedE2eUsers: false,
      e2eAdminPassword: "e2e-admin-password",
    },
    log: () => {},
  });
}

/** Truncate everything and re-seed the baseline settings. */
export async function resetDatabase(opts: { seed?: boolean } = {}) {
  await truncateAll();
  if (opts.seed ?? true) await seedBaseline();
}

/** Register `beforeEach(resetDatabase)` for the current file or `describe` block. */
export function cleanDatabaseBeforeEach(opts: { seed?: boolean } = {}): void {
  beforeEach(async () => {
    await resetDatabase(opts);
  });
}

/** SQLSTATE of a pg error, also when wrapped by Drizzle (`DrizzleQueryError.cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  let e: unknown = error;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Name of the violated constraint, also when wrapped by Drizzle. */
export function pgConstraint(error: unknown): string | undefined {
  let e: unknown = error;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === "string") return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Await `promise`, expect it to fail with SQLSTATE `code` (e.g. 23505 unique, 23514 check,
 * 23503 foreign key) and, when given, the named constraint.
 */
export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(caught)).toBe(code);
  if (constraint) expect(pgConstraint(caught)).toBe(constraint);
}
