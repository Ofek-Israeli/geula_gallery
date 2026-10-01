/**
 * A parsed `Env` for adapter contract tests: the fixed test environment (`applyTestEnv`, which also
 * scrubs real provider credentials from `process.env`) plus per-test overrides, run through the
 * real `parseEnv` so every derived field and cross-field rule applies. `@/server/env` is imported
 * lazily, after `applyTestEnv`, because it parses `process.env` at import.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { applyTestEnv, testEnv } from "../../helpers/db";

export type Env = import("@/server/env").Env;

/**
 * Live-test credentials: `applyTestEnv` scrubs provider variables, so the opt-in live blocks read
 * them from this snapshot of the shell (taken first) or from `.env.local`.
 */
const shellSnapshot = { ...process.env };

export function liveVar(key: string): string | undefined {
  const fromShell = shellSnapshot[key]?.trim();
  if (fromShell) return fromShell;
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return undefined;
  return parseEnv(readFileSync(file, "utf8"))[key]?.trim() || undefined;
}

export const liveEnabled = (flag: string) =>
  /^(1|true|yes)$/i.test(shellSnapshot[flag] ?? "");

applyTestEnv();

export async function makeEnv(
  overrides: Record<string, string | undefined> = {},
): Promise<Env> {
  const { parseEnv: parseAppEnv } = await import("@/server/env");
  return parseAppEnv({ ...testEnv(), ...overrides });
}

/** Placeholder credentials (never real ones). */
export const CARDCOM_ENV = {
  CARDCOM_MODE: "test",
  CARDCOM_TERMINAL_NUMBER: "1000",
  CARDCOM_API_NAME: "placeholder-api-name",
  PAYMENT_PROVIDERS: "mock,cardcom",
};

export const PAYPAL_ENV = {
  PAYPAL_MODE: "sandbox",
  PAYPAL_CLIENT_ID: "placeholder-client-id",
  PAYPAL_CLIENT_SECRET: "placeholder-client-secret",
  PAYPAL_WEBHOOK_ID: "WH-PLACEHOLDER",
  PAYPAL_MERCHANT_ID: "TESTMERCHANT01",
  PAYMENT_PROVIDERS: "mock,paypal",
};

export const MORNING_ENV = {
  TAX_DOCUMENTS_MODE: "morning",
  MORNING_MODE: "sandbox",
  MORNING_CLIENT_ID: "placeholder-morning-id",
  MORNING_CLIENT_SECRET: "placeholder-morning-secret",
};
