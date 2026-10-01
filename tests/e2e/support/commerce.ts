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

/**
 * Opens a `ConfirmButton` dialog and confirms it. The dialog opens from a client handler, so a
 * click that lands before hydration does nothing: retry the click until the dialog is visible.
 */
export async function clickAndConfirm(
  page: Page,
  buttonName: string,
  confirmName: string,
): Promise<void> {
  const confirm = page.getByRole("button", { name: confirmName, exact: true });
  await expect(async () => {
    await page.getByRole("button", { name: buttonName }).click();
    await expect(confirm).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await confirm.click();
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

// ---------------------------------------------------------------- M3 (WS2) helpers

/**
 * Fixture inventory for the M3 commerce specs. The demo catalog has only a handful of works that
 * the checkout can sell, and every purchase spends one for the whole run, so each WS2 scenario
 * buys its own published copy of a demo work (`e2e-<name>`, same images, prices and packaging;
 * last in the sort order, never featured). This is the only state these specs arrange directly;
 * everything else goes through the app. Storefront specs that count works should ignore `e2e-`
 * slugs.
 */
export async function cloneWork(source: string, slug: string): Promise<void> {
  const skip = new Set([
    "id",
    "slug",
    "inventory_number",
    "featured",
    "sort_order",
    "sale_status",
    "hold_reason",
    "hold_note",
    "reserved_by_order_id",
    "reserved_until",
    "sold_at",
    "created_at",
    "updated_at",
  ]);
  const client = new pg.Client({
    connectionString: e2eDatabaseUrl(),
    application_name: "geula-e2e-fixtures",
  });
  await client.connect();
  try {
    const cols = (
      await client.query<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'artworks' ORDER BY ordinal_position`,
      )
    ).rows
      .map((r) => r.name)
      .filter((c) => !skip.has(c));
    const list = cols.map((c) => `"${c}"`).join(", ");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO artworks (slug, featured, sort_order, sale_status, ${list})
       SELECT $2, false, 9999, 'AVAILABLE', ${list} FROM artworks WHERE slug = $1
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [source, slug],
    );
    const id = inserted.rows[0]?.id;
    if (!id) return; // already cloned in this run
    const imageCols = (
      await client.query<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'artwork_images' ORDER BY ordinal_position`,
      )
    ).rows
      .map((r) => r.name)
      .filter(
        (c) => !["id", "artwork_id", "created_at", "updated_at"].includes(c),
      );
    const ilist = imageCols.map((c) => `"${c}"`).join(", ");
    await client.query(
      `INSERT INTO artwork_images (artwork_id, ${ilist})
       SELECT $2, ${ilist} FROM artwork_images
        WHERE artwork_id = (SELECT id FROM artworks WHERE slug = $1)`,
      [source, id],
    );
  } finally {
    await client.end();
  }
}

/** The mock payment's cancel URL: opens the order page without changing the payment. */
export async function orderPageUrlForRef(ref: string): Promise<string> {
  const rows = await e2eQuery<{ cancel_url: string }>(
    "SELECT cancel_url FROM mock_payments WHERE ref = $1",
    [ref],
  );
  const url = rows[0]?.cancel_url;
  if (!url) throw new Error(`no mock payment ${ref}`);
  return url;
}

/**
 * The buyer releases the hold from the order page while the provider page stays open in another
 * tab (the "hold lost" setup of late-payment and capture-mode).
 */
export async function releaseFromSecondTab(
  page: Page,
  ref: string,
  locale: "he" | "en" = "en",
): Promise<void> {
  const tab = await page.context().newPage();
  await tab.goto(await orderPageUrlForRef(ref));
  const orders = messages(locale, "orders");
  const common = messages(locale, "common");
  await clickAndConfirm(tab, orders.release, common.form.confirm);
  await expect(tab.getByText(orders.released)).toBeVisible();
  await tab.close();
}

/** Another buyer (own context and IP) buys `slug` with studio pickup and pays. */
export async function anotherBuyerBuys(
  page: Page,
  slug: string,
  ip: number,
): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("no browser");
  const ctx = await browser.newContext({
    extraHTTPHeaders: buyerIp(ip),
    baseURL: new URL(page.url()).origin,
  });
  try {
    const other = await ctx.newPage();
    await other.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
    const { uniqueBuyer } = await import("../../helpers/factories/core");
    await fillCheckout(other, { locale: "en", ...uniqueBuyer("other") });
    await continueToMockPay(other);
    await other.getByTestId("mock-pay").click();
    await expect(other).toHaveURL(/payment=paid/);
  } finally {
    await ctx.close();
  }
}

export async function artworkStatus(slug: string) {
  const rows = await e2eQuery<{
    sale_status: string;
    reserved_by_order_id: string | null;
  }>("SELECT sale_status, reserved_by_order_id FROM artworks WHERE slug = $1", [
    slug,
  ]);
  return rows[0];
}

/** Runs the outbox until it is idle (jobs enqueued by handlers run in the next batch). */
export async function drainOutbox(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < 4; i++) await runCron(request, "outbox");
}
