import { randomBytes } from "node:crypto";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import sharp from "sharp";
import { e2eArrangePaidOrder } from "../helpers/factories/shipping";
import { ADMIN_STORAGE_STATE, E2E_SECRETS } from "./e2e-env";
import {
  clickAndConfirm,
  e2eDatabaseUrl,
  e2eQuery,
  messages,
} from "./support/commerce";

/**
 * Spec §10.4 `fulfill`: a packing photo upload (a ~5 MB image through `purpose=packing`), customs,
 * a mock label, the tracking cron → DELIVERED, the printables, the label only via a signed URL,
 * and pickup collection blocked until the disclosure hand-over is confirmed.
 *
 * Orders are arranged directly in the E2E database (`e2eArrangePaidOrder`: an unpublished SOLD
 * work, a paid order bound to its quote, the sale and the shipment row), so these specs never
 * sell a shared demo work.
 */
const he = messages("he", "shipping");

test.use({ storageState: ADMIN_STORAGE_STATE });

async function cron(request: APIRequestContext, job: "tracking" | "outbox") {
  const res = await request.get(`/api/cron/${job}`, {
    headers: { Authorization: `Bearer ${E2E_SECRETS.CRON_SECRET}` },
  });
  expect(res.status(), `cron ${job}`).toBe(200);
  return res.json();
}

async function status(page: Page, key: string) {
  await expect(page.getByTestId("fulfill-status")).toHaveText(he.status[key]);
}

/** A ~5 MB JPEG of noise (noise does not compress), generated per run instead of committed. */
async function bigPhoto(): Promise<Buffer> {
  const [w, h] = [2200, 1700];
  const buf = await sharp(randomBytes(w * h * 3), {
    raw: { width: w, height: h, channels: 3 },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
  expect(buf.length).toBeGreaterThan(5_000_000);
  return buf;
}

test("international parcel: photo, customs, mock label, tracking → delivered, printables", async ({
  page,
  request,
  playwright,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const o = await e2eArrangePaidOrder(e2eDatabaseUrl(), {
    country: "US",
    method: "CARRIER_TABLE",
  });
  const url = `/he/admin/orders/${o.orderId}/fulfill`;
  await page.goto(url);
  await status(page, "AWAITING_FULFILLMENT");

  // 1. Pack: tick the checklist, upload a large photo, confirm.
  const pack = page.getByTestId("pack-form");
  for (const box of await pack.getByRole("checkbox").all()) await box.check();
  await page.getByTestId("packing-photo-input").setInputFiles({
    name: "packing.jpg",
    mimeType: "image/jpeg",
    buffer: await bigPhoto(),
  });
  await expect(page.getByTestId("packing-photos-status")).toHaveText(
    "הועלתה תמונה אחת",
    { timeout: 30_000 },
  );
  await pack.getByRole("button", { name: he.fulfill.pack.submit }).click();
  await status(page, "PACKED");
  const [stored] = await e2eQuery<{ keys: string[] }>(
    "SELECT packing_photo_keys AS keys FROM shipments WHERE order_id = $1",
    [o.orderId],
  );
  expect(stored?.keys).toHaveLength(1);
  expect(stored?.keys[0]).toMatch(
    /^packing\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/,
  );

  // 2. Customs: the export declaration is required (USD 870 > USD 200); the carrier files it.
  const customs = page.getByTestId("customs-form");
  await customs
    .getByRole("button", { name: he.fulfill.customs.submit })
    .click();
  await expect(page.getByTestId("customs-form-result")).toHaveText(
    he.fulfill.result.saved,
  );

  // 3. Mock label behind the confirmation dialog.
  await clickAndConfirm(
    page,
    he.fulfill.ship.buyLabel.replace("{carrier}", "MOCK"),
    he.fulfill.ship.buyConfirm,
  );
  await status(page, "LABEL_CREATED");
  await expect(page.getByTestId("tracking-number")).toContainText(/MOCK\d{10}/);

  // The label is private: only the signed URL works without a session.
  const href =
    (await page.getByTestId("label-link").getAttribute("href")) ?? "";
  expect(href).toMatch(/^\/api\/files\/private\/labels\/.+\.pdf\?t=/);
  const anonymous = await playwright.request.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const unsigned = await anonymous.get(href.split("?")[0] as string);
  expect([401, 403]).toContain(unsigned.status());
  const signed = await anonymous.get(href);
  expect(signed.status()).toBe(200);
  expect(signed.headers()["content-type"]).toContain("application/pdf");
  expect((await signed.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  await anonymous.dispose();

  // Printables render for the admin.
  const slip = await page.request.get(
    `/he/print/admin/packing-slip/${o.orderId}`,
  );
  expect(slip.status()).toBe(200);
  const slipHtml = await slip.text();
  expect(slipHtml).toContain(o.orderNumber);
  expect(slipHtml).toContain('data-testid="insert-disclosure"');
  const invoice = await page.request.get(
    `/he/print/admin/commercial-invoice/${o.orderId}`,
  );
  expect(invoice.status()).toBe(200);
  const invoiceHtml = await invoice.text();
  expect(invoiceHtml).toContain(`CI-${o.orderNumber}`);
  expect(invoiceHtml).toContain("9701910000 / 9701.91.0000");
  expect(invoiceHtml).toContain("DAP");

  // 4. Tracking: MOCK_CARRIER_DELIVERY_SECONDS=1, so the next poll delivers.
  await page.waitForTimeout(1_500);
  const run = await cron(request, "tracking");
  expect(run.stats).toMatchObject({ checked: 1, updated: 1 });
  await page.reload();
  await status(page, "DELIVERED");
  await expect(page.getByTestId("shipment-events")).toContainText("Delivered");
  const [order] = await e2eQuery<{ delivered_at: Date | null }>(
    "SELECT delivered_at FROM orders WHERE id = $1",
    [o.orderId],
  );
  expect(order?.delivered_at).not.toBeNull();

  // One buyer email per status, sent by the outbox.
  await cron(request, "outbox");
  await cron(request, "outbox");
  const emails = await e2eQuery<{ subject: string; status: string }>(
    "SELECT subject, status FROM email_messages WHERE template = 'shipment-update' AND to_email = $1",
    [o.buyerEmail],
  );
  expect(emails.length).toBeGreaterThanOrEqual(3);
  expect(emails.every((e) => e.status === "SENT")).toBe(true);
});

test("pickup: collection is blocked until the printed disclosure is confirmed", async ({
  page,
  request,
}) => {
  const o = await e2eArrangePaidOrder(e2eDatabaseUrl(), {
    country: "IL",
    method: "LOCAL_PICKUP",
    disclosureSent: false,
  });
  await page.goto(`/he/admin/orders/${o.orderId}/fulfill`);
  await status(page, "AWAITING_FULFILLMENT");
  await page
    .getByTestId("ready-pickup-form")
    .getByRole("button", { name: he.fulfill.ship.pickup.ready })
    .click();
  await status(page, "READY_FOR_PICKUP");

  const collected = page.getByTestId("collected-form");
  await collected
    .getByRole("button", { name: he.fulfill.ship.pickup.collected })
    .click();
  await expect(page.getByTestId("collected-form-result")).toHaveText(
    he.errors.DISCLOSURE_REQUIRED,
  );
  await status(page, "READY_FOR_PICKUP");

  await collected.getByLabel(he.fulfill.ship.pickup.handedOverCheck).check();
  await collected
    .getByRole("button", { name: he.fulfill.ship.pickup.collected })
    .click();
  await status(page, "COLLECTED");
  const [order] = await e2eQuery<{
    disclosure_handed_over_at: Date | null;
    delivered_at: Date | null;
  }>(
    "SELECT disclosure_handed_over_at, delivered_at FROM orders WHERE id = $1",
    [o.orderId],
  );
  expect(order?.disclosure_handed_over_at).not.toBeNull();
  expect(order?.delivered_at).not.toBeNull();

  // The ready-for-pickup email (with the address) went out.
  await cron(request, "outbox");
  const sent = await e2eQuery<{ status: string }>(
    "SELECT status FROM email_messages WHERE template = 'ready-for-pickup' AND to_email = $1",
    [o.buyerEmail],
  );
  expect(sent.map((s) => s.status)).toEqual(["SENT"]);
});
