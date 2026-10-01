/**
 * Shared steps for the commerce E2E specs (M2 acceptance: purchase-il, webhook, order-retry,
 * race). WS2 owns this file and extends it.
 *
 * - Every spec sends its own `x-real-ip` (`buyerIp()`), so the per-IP hold caps (3 live holds per
 *   IP, not scaled by RATE_LIMIT_SCALE) never trip across parallel specs that share localhost.
 * - Each spec buys its own demo work: the E2E database is reset once per run, not per test.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import pg from "pg";
import { createMailbox } from "../../helpers/mailbox";
import { E2E_SECRETS } from "../e2e-env";

/** Same resolution as playwright.config.ts. */
export function e2eDatabaseUrl(): string {
  const local: Record<string, string | undefined> = existsSync(".env.local")
    ? parseEnv(readFileSync(".env.local", "utf8"))
    : {};
  return (
    process.env.E2E_DATABASE_URL?.trim() ||
    local.E2E_DATABASE_URL?.trim() ||
    "postgres://localhost:5432/geula_e2e"
  );
}

export const mailbox = createMailbox(e2eDatabaseUrl());

/** One-off query against the E2E database (assertions only; never arrange state with it). */
export async function e2eQuery<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({
    connectionString: e2eDatabaseUrl(),
    application_name: "geula-e2e-specs",
  });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** A documentation-range IP per spec (RFC 5737), so per-IP caps stay per spec. */
export function buyerIp(n: number): Record<string, string> {
  return { "x-real-ip": `198.51.100.${n}` };
}

export async function runCron(
  request: APIRequestContext,
  job: "reconcile" | "outbox",
): Promise<Record<string, unknown>> {
  const res = await request.get(`/api/cron/${job}`, {
    headers: { Authorization: `Bearer ${E2E_SECRETS.CRON_SECRET}` },
  });
  expect(res.status(), `cron ${job}`).toBe(200);
  return res.json();
}

/** A message file of the app (`messages/<locale>/<namespace>.json`). */
// biome-ignore lint/suspicious/noExplicitAny: message trees are read untyped in specs
export function messages(locale: "he" | "en", namespace: string): any {
  return JSON.parse(
    readFileSync(`messages/${locale}/${namespace}.json`, "utf8"),
  );
}

const MSG = {
  he: messages("he", "checkout"),
  en: messages("en", "checkout"),
} as const;

export interface FillOptions {
  locale: "he" | "en";
  name: string;
  email: string;
  /** IL courier: fill the delivery address. */
  address?: boolean;
  receiptByEmail?: boolean;
}

/** Fills the checkout details form (labels from the message files) and ticks the consents. */
export async function fillCheckout(page: Page, o: FillOptions): Promise<void> {
  const m = MSG[o.locale];
  const box = (label: string) =>
    page.getByRole("textbox", { name: new RegExp(`^${escapeRe(label)}`) });
  await box(m.details.name).fill(o.name);
  await box(m.details.email).fill(o.email);
  await box(m.details.phone).fill("+97230000000");
  if (o.address) {
    await box(m.details.line1).fill("Herzl 1");
    await box(m.details.city).fill("Tel Aviv");
    await box(m.details.postalCode).fill("6100000");
  }
  await page.getByLabel(m.consent.terms).check();
  await page.getByLabel(m.consent.age).check();
  if (o.receiptByEmail) await page.getByLabel(m.consent.receiptEmail).check();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Submits the checkout and lands on the mock hosted page; returns the mock payment ref. */
export async function continueToMockPay(page: Page): Promise<string> {
  await page.getByTestId("checkout-submit").click();
  await expect(page).toHaveURL(/\/(he|en)\/mock-pay\/mock_[0-9a-f]{32}/);
  const ref = /mock-pay\/(mock_[0-9a-f]{32})/.exec(page.url())?.[1];
  if (!ref) throw new Error("no mock ref in the URL");
  return ref;
}

export async function orderStatusByRef(
  ref: string,
): Promise<string | undefined> {
  const rows = await e2eQuery<{ status: string }>(
    `SELECT o.status FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
      WHERE pa.provider_ref = $1`,
    [ref],
  );
  return rows[0]?.status;
}
