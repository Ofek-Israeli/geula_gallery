import { type APIRequestContext, expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import { ADMIN_STORAGE_STATE } from "./e2e-env";
import {
  buyerIp,
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
 * the inline disclosure summary), painter notification and receipt emails → the mock receipt
 * (stamped DEMO) and the disclosure document → the admin sees the order, its receipt, and records
 * manual tracking. The disclosure PDF attachment is Tier B (WS6): `test.fixme` below.
 */
const SLUG = "movement-no-10";
const heOrders = messages("he", "orders");
const heArtwork = messages("he", "artwork");
const heAdminOrders = messages("he", "admin-orders");

test.use({ extraHTTPHeaders: buyerIp(11) });

test("IL purchase in Hebrew: pay → Sold → emails → mock receipt → admin", async ({
  page,
  browser,
  request,
}) => {
  const buyer = uniqueBuyer("purchase-il");

  // Checkout (Hebrew, courier to an Israeli address, receipt by email).
  const res = await page.goto(`/he/checkout/${SLUG}?to=IL&ship=CARRIER_TABLE`);
  expect(res?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await fillCheckout(page, {
    locale: "he",
    name: buyer.name,
    email: buyer.email,
    address: true,
    receiptByEmail: true,
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
  const [order] = await e2eQuery<{ id: string }>(
    "SELECT id FROM orders WHERE number = $1",
    [number],
  );
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
  const painter = await waitForMail(request, {
    template: "painter-new-order",
    orderId,
  });
  expect(painter.locale).toBe("he");
  expect(painter.subject).toContain(number);
  const receiptMail = await waitForMail(request, {
    template: "receipt",
    orderId,
  });
  expect(receiptMail.text).toContain("הדגמה – אינו מסמך חשבונאי");

  // The mock receipt, via the link in the email.
  const receiptUrl = /href="([^"]*\/print\/receipt\/DEMO-[^"]+)"/.exec(
    receiptMail.html ?? "",
  )?.[1];
  expect(receiptUrl).toBeTruthy();
  await page.goto(receiptUrl ?? "");
  await expect(page.getByTestId("demo-stamp")).toContainText(
    "DEMO – not a tax document",
  );
  await expect(page.getByTestId("doc-number")).toHaveText(
    /^DEMO-[0-9A-Z]{6}-R1$/,
  );
  const docNumber = (await page.getByTestId("doc-number").textContent()) ?? "";

  // The disclosure document, via the link in the confirmation.
  const disclosureUrl = /href="([^"]*\/print\/disclosure\/[^"]+)"/.exec(
    confirmation.html ?? "",
  )?.[1];
  await page.goto(disclosureUrl ?? "");
  await expect(page.getByTestId("disclosure-document")).toContainText(number);
  await expect(page.getByTestId("disclosure-document")).toContainText(
    "מדינת העוסק",
  );

  // A wrong token is a 404 for both printables.
  const bad = await page.goto(`/he/print/receipt/${docNumber}?k=wrong`);
  expect(bad?.status()).toBe(404);

  // The admin sees the order, its receipt, and records manual tracking.
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

test.fixme("order-confirmation carries the disclosure PDF attachment (Tier B, lands in WS6)", () => {});

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
