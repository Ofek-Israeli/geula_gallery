import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig, devices } from "@playwright/test";
import { E2E_ADMIN, E2E_SECRETS } from "./tests/e2e/e2e-env";

/**
 * Playwright 1.63 (spec §10.4). `npm run test:e2e [-- <playwright args>]`.
 *
 * The web server is a production build on its own database, port and dist dir:
 *   db:reset (E2E db, demo seed) → next build (NEXT_DIST_DIR=.next-e2e) → next start -p E2E_PORT
 * Its environment is pinned below. Process env overrides `.env.local` for Next and the scripts,
 * and every provider credential is blanked, so real keys never reach an E2E server; the boot
 * assertion in `src/server/env.ts` (APP_ENV=test ⇒ auth and webhook hosts equal APP_URL's)
 * catches leaks of the dev URLs.
 *
 * Set `E2E_REUSE_SERVER=1` to reuse a server already listening on E2E_PORT (local iteration).
 */
const local: Record<string, string | undefined> = existsSync(".env.local")
  ? parseEnv(readFileSync(".env.local", "utf8"))
  : {};
const pick = (key: string, fallback: string) =>
  process.env[key]?.trim() || local[key]?.trim() || fallback;

const E2E_PORT = Number(pick("E2E_PORT", "3100"));
const E2E_DATABASE_URL = pick(
  "E2E_DATABASE_URL",
  "postgres://localhost:5432/geula_e2e",
);
const E2E_DB = decodeURIComponent(
  new URL(E2E_DATABASE_URL).pathname.replace(/^\//, ""),
);
const BASE_URL = `http://localhost:${E2E_PORT}`;

/** Keys inherited from the shell or `.env.local` that must not reach the E2E server. */
const BLANKED = Object.keys({ ...local, ...process.env }).filter((k) =>
  /^(CARDCOM_|PAYPAL_|MORNING_|DHL_|RESEND_|BLOB_|NEXT_PUBLIC_BLOB_)/.test(k),
);

const serverEnv: Record<string, string> = {
  ...Object.fromEntries(BLANKED.map((k) => [k, ""])),
  APP_ENV: "test",
  APP_URL: BASE_URL,
  PUBLIC_WEBHOOK_BASE_URL: BASE_URL,
  BETTER_AUTH_URL: BASE_URL,
  NEXT_DIST_DIR: ".next-e2e",
  DATABASE_URL: E2E_DATABASE_URL,
  DATABASE_URL_UNPOOLED: "",
  E2E_DATABASE_URL,
  E2E_PORT: String(E2E_PORT),
  APP_SECRET: "e2e-app-secret-0123456789abcdef0123456789",
  // base64 of 32 fixed bytes (AES-256-GCM); E2E only.
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 0x2e).toString("base64"),
  BETTER_AUTH_SECRET: "e2e-better-auth-secret-0123456789abcdef",
  ADMIN_REQUIRE_2FA: "false",
  ADMIN_EMAIL: "painter@example.test",
  ADMIN_PASSWORD: "e2e-painter-password",
  SEED_E2E_USERS: "true",
  E2E_ADMIN_PASSWORD: E2E_ADMIN.password,
  DEMO_MODE: "true",
  RATE_LIMIT_SCALE: "100",
  FORM_MIN_AGE_MS: "0",
  CRON_SECRET: E2E_SECRETS.CRON_SECRET,
  PAYMENT_PROVIDERS: "mock",
  MOCK_WEBHOOK_SECRET: E2E_SECRETS.MOCK_WEBHOOK_SECRET,
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
  LOCAL_STORAGE_DIR: ".data/e2e-uploads",
};

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  metadata: { e2eDatabase: E2E_DB },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /admin-auth\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      grep: /@mobile|@smoke/,
      testIgnore: /admin-auth\.spec\.ts/,
    },
    {
      // Exhausts the sign-in rate limits, so it runs after everything else.
      name: "auth-limits",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /admin-auth\.spec\.ts/,
      dependencies: ["desktop-chromium"],
    },
  ],
  webServer: {
    command: `npm run db:reset -- --db ${E2E_DB} --seed demo --yes && npm run build && npm run start -- -p ${E2E_PORT}`,
    url: `${BASE_URL}/api/health`,
    env: serverEnv,
    timeout: 300_000,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    stdout: "pipe",
    stderr: "pipe",
  },
});
