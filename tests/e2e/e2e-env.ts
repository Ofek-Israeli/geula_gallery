/**
 * Constants shared by `playwright.config.ts` and the E2E specs. Every value is an obviously fake
 * `e2e-` test value: the E2E server never sees real credentials.
 */
export const E2E_ADMIN = {
  email: "e2e-admin@example.test",
  /** Second seeded admin for TOTP enrolment specs (`admin-auth`). */
  totpEmail: "e2e-2fa@example.test",
  password: "e2e-admin-password",
} as const;

export const E2E_SECRETS = {
  MOCK_WEBHOOK_SECRET: "e2e-mock-webhook-secret-0123456789",
  CRON_SECRET: "e2e-cron-secret-0123456789",
} as const;

/** Storage state written by `global-setup.ts` (gitignored). */
export const ADMIN_STORAGE_STATE = "tests/e2e/.auth/admin.json";
