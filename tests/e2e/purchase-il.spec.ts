import { type APIRequestContext, expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import { ADMIN_STORAGE_STATE } from "./e2e-env";
import {
  buyerIp,
  chooseDelivery,
  chooseDestination,
  continueToMockPay,
  e2eQuery,
  fillCheckout,
  mailbox,
  messages,
  runCron,
} from "./support/commerce";

/**
 * Spec §10.4 `purchase-il` (M2 acceptance): a full Israeli purchase in Hebrew with courier
 * delivery → mock payment → order page "Paid" → the work shows "Sold" → order confirmation (with
 * the inline disclosure summary) and painter notification emails, and no receipt email (receipts
 * are issued by hand; the server's mock mode still records a demo document) → the disclosure
 * document → the admin sees the order, its document, and records manual tracking. The
 * confirmation carries the disclosure PDF attachment (Tier B, WS6).
 */
const SLUG = "blue-and-yellow-notes";
const heOrders = messages("he", "orders");
const heArtwork = messages("he", "artwork");
const heAdminOrders = messages("he", "admin-orders");

test.use({ extraHTTPHeaders: buyerIp(11) });

test("IL purchase in Hebrew: pay → Sold → emails, no receipt email → admin", async ({
  page,
  browser,
  request,
}) => {
  const buyer = uniqueBuyer("purchase-il");

  // Checkout (Hebrew, courier to an Israeli address): destination → courier →
  // details with the street address only.
  const res = await page.goto(`/he/checkout/${SLUG}`);
  expect(res?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await chooseDestination(page, {
    locale: "he",
    city: "תל אביב",
    zip: "6100000",
  });
  await chooseDelivery(page, { locale: "he", method: "CARRIER_TABLE" });
  await fillCheckout(page, {
    locale: "he",
    name: buyer.name,
    email: buyer.email,
    address: true,
  });
  await continueToMockPay(page);
  await page.getByTestId("mock-pay").click();

  // Order page.
  await expect(page).toHaveURL(
    /\/he\/orders\/GG-[0-9A-Z]{6}\?k=.*payment=paid/,
  );
  await expect(page.getByTestId("order-status")).toHaveText(
    heOrders.status.PAID,
  );
  const number = (await page.getByTestId("order-number").textContent()) ?? "";
  expect(number).toMatch(/^GG-[0-9A-Z]{6}$/);
  // The cancellation link is on the order page too (spec §1.2).
  await expect(
    page.getByRole("link", { name: "ביטול עסקה" }).first(),
  ).toHaveAttribute("href", "/he/cancel");

  // The work is sold, as text.
  await page.goto(`/he/works/${SLUG}`);
  await expect(page.getByTestId("artwork-status")).toHaveText(
    heArtwork.status.sold,
  );

  // Emails (log driver). Cron drains whatever `after()` has not sent yet.
  const [order] = await e2eQuery<{
    id: string;
    ship_city: string;
    ship_postal_code: string;
    ship_line1: string;
  }>(
    "SELECT id, ship_city, ship_postal_code, ship_line1 FROM orders WHERE number = $1",
    [number],
  );
  // City and postal code came from the destination step, the street from the details form.
  expect(order).toMatchObject({
    ship_city: "תל אביב",
    ship_postal_code: "6100000",
    ship_line1: "Herzl 1",
  });
  const orderId = order?.id ?? "";
  const confirmation = await waitForMail(request, {
    template: "order-confirmation",
    orderId,
  });
  expect(confirmation.toEmail).toBe(buyer.email);
  expect(confirmation.locale).toBe("he");
  expect(confirmation.subject).toContain(number);
  expect(confirmation.html).toContain('dir="rtl"');
  expect(confirmation.html).toContain(`/he/print/disclosure/${number}?k=`);
  expect(confirmation.text).toContain("מסמך הגילוי");
  // Tier B (WS6): the disclosure PDF is attached (metadata only is stored).
  const attached = (confirmation.attachments ?? []) as {
    filename: string;
    contentType: string;
    bytes: number;
  }[];
  expect(attached).toHaveLength(1);
  expect(attached[0]?.contentType).toBe("application/pdf");
  expect(attached[0]?.filename).toMatch(/\.pdf$/);
  expect(attached[0]?.bytes).toBeGreaterThan(1_000);
  const painter = await waitForMail(request, {
    template: "painter-new-order",
    orderId,
  });
  expect(painter.locale).toBe("he");
  expect(painter.subject).toContain(number);
  // Receipts are issued by hand, so the buyer is never emailed one, even once the server's mock
  // mode has recorded its demo document.
  let docNumber = "";
  for (let i = 0; i < 20 && !docNumber; i++) {
    await runCron(request, "outbox");
    const [doc] = await e2eQuery<{ doc_number: string | null }>(
      "SELECT doc_number FROM tax_documents WHERE order_id = $1 AND kind = 'RECEIPT' AND status = 'ISSUED'",
      [orderId],
    );
    docNumber = doc?.doc_number ?? "";
    if (!docNumber) await new Promise((r) => setTimeout(r, 300));
  }
  expect(docNumber).toMatch(/^DEMO-[0-9A-Z]{6}-R1$/);
  const [receiptMails] = await e2eQuery<{ n: number }>(
    "SELECT count(*)::int AS n FROM email_messages WHERE order_id = $1 AND template = 'receipt'",
    [orderId],
  );
  expect(receiptMails?.n).toBe(0);

  // The disclosure document, via the link in the confirmation.
  const disclosureUrl = /href="([^"]*\/print\/disclosure\/[^"]+)"/.exec(
    confirmation.html ?? "",
  )?.[1];
  await page.goto(disclosureUrl ?? "");
  await expect(page.getByTestId("disclosure-document")).toContainText(number);
  await expect(page.getByTestId("disclosure-document")).toContainText(
    "מדינת העוסק",
  );

  // A wrong token is a 404.
  const bad = await page.goto(`/he/print/disclosure/${number}?k=wrong`);
  expect(bad?.status()).toBe(404);

  // The admin sees the order, its document, and records manual tracking.
  const admin = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  try {
    const ap = await admin.newPage();
    await ap.goto(`/he/admin/orders?q=${encodeURIComponent(number)}`);
    await ap.getByRole("link", { name: number }).click();
    await expect(ap.getByTestId("admin-order-number")).toHaveText(number);
    await expect(ap.getByTestId("admin-order-status")).toHaveText(
      heAdminOrders.status.PAID,
    );
    await expect(ap.getByTestId("admin-documents")).toContainText(docNumber);
    await expect(ap.getByTestId("attempt-status")).toHaveText("SUCCEEDED");
    // A final attempt has nothing to recheck.
    await expect(ap.getByTestId("recheck-payment")).toHaveCount(0);

    const form = ap.getByTestId("manual-tracking-form");
    await form
      .getByRole("textbox", {
        name: new RegExp(`^${heAdminOrders.tracking.carrierName}`),
      })
      .fill("דואר ישראל");
    await form
      .getByRole("textbox", {
        name: new RegExp(`^${heAdminOrders.tracking.trackingNumber}`),
      })
      .fill("RR123456785IL");
    await form
      .getByRole("button", { name: heAdminOrders.tracking.submit })
      .click();
    await expect(ap.getByTestId("tracking-result")).toContainText(
      "LABEL_CREATED",
    );
    await expect(ap.getByTestId("shipment-status")).toHaveText("LABEL_CREATED");
  } finally {
    await admin.close();
  }
});

async function waitForMail(
  request: APIRequestContext,
  q: { template: string; orderId: string },
) {
  for (let i = 0; i < 10; i++) {
    const found = await mailbox.latest({ ...q, status: "SENT" });
    if (found) return found;
    await runCron(request, "outbox");
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no ${q.template} email for order ${q.orderId}`);
}
