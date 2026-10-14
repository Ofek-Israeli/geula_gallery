import { expect, type Page, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  artworkStatus,
  buyerIp,
  checkoutUrl,
  chooseDelivery,
  chooseDestination,
  cloneWork,
  e2eQuery,
  escapeRe,
  fillCheckout,
  messages,
  seriousAxeViolations,
} from "./support/commerce";

/**
 * The site as Isracard reviews it (`preview` project, its own server; playwright.config.ts
 * `previewEnv`): sales closed, the purchase flow public (CHECKOUT_PREVIEW), real listings, and
 * Isracard in test mode against `support/payme-stub.mjs`. The spec buys only its own real copy of
 * a work, so it runs alongside the other projects.
 */
const SLUG = "e2e-preview-the-path";
const common = messages("en", "common");
const checkout = messages("en", "checkout");
const orders = messages("en", "orders");
const TEST_CARD = "5326105300985846";
const DECLINED_CARD = "4000000000000002";

test.describe.configure({ mode: "serial" });
test.use({ extraHTTPHeaders: buyerIp(91) });

test.beforeAll(async () => {
  await cloneWork("the-path", SLUG, { real: true });
});

interface StubRequest {
  path: string;
  body: Record<string, unknown>;
  saleId?: string;
}

const holderBox = (page: Page, label: string) =>
  page.getByRole("textbox", { name: new RegExp(`^${escapeRe(label)}`) });

/** The card holder's details on the pay page. */
async function fillHolder(
  page: Page,
  buyer: { name: string; email: string },
): Promise<void> {
  const [first, last] = buyer.name.split(" ", 2) as [string, string];
  await holderBox(page, checkout.pay.firstName).fill(first);
  await holderBox(page, checkout.pay.lastName).fill(last);
  await holderBox(page, checkout.pay.email).fill(buyer.email);
  await holderBox(page, checkout.pay.phone).fill("0500000000");
}

/** Types a card into the stand-in card fields. */
async function fillCard(page: Page, card: string): Promise<void> {
  await page.locator("[data-stub-field=cardNumber]").fill(card);
  await page.locator("[data-stub-field=cardExpiration]").fill("12/30");
  await page.locator("[data-stub-field=cvc]").fill("658");
}

/** Card and holder details, then Pay. */
async function payWith(
  page: Page,
  card: string,
  buyer: { name: string; email: string },
): Promise<void> {
  await expect(page.getByTestId("pay-submit")).toBeEnabled();
  await fillCard(page, card);
  await fillHolder(page, buyer);
  await page.getByTestId("pay-submit").click();
}

/** The error summary's items (its links), in order. */
async function summaryItems(page: Page): Promise<string[]> {
  const summary = page.getByRole("alert").filter({
    has: page.getByRole("heading"),
  });
  await expect(summary).toBeFocused();
  return summary.getByRole("link").allTextContents();
}

test("the banner, Buy now with sales closed, and Isracard in test mode at checkout", async ({
  page,
}) => {
  await page.goto(`/en/works/${SLUG}`);
  await expect(page.getByTestId("preview-banner")).toContainText(
    common.preview.banner,
  );
  await page.getByTestId("buy-now").click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${SLUG}`));
  await chooseDestination(page, { locale: "en", city: "Haifa" });
  await chooseDelivery(page, { locale: "en", method: "LOCAL_PICKUP" });

  await expect(page.getByTestId("summary-line")).toHaveCount(1);
  await expect(
    page.getByRole("radio", {
      name: new RegExp(
        `^${escapeRe(checkout.provider.isracard + checkout.provider.testSuffix)}`,
      ),
    }),
  ).toBeChecked();
  await expect(page.getByTestId("payments-pending")).toHaveCount(0);
  await expect(page.getByTestId("checkout-card-page")).toContainText(
    checkout.cardPage.secureFields,
  );
  await expect(page.getByTestId("checkout-secure")).toBeVisible();
  await expect(page.getByTestId("checkout-submit")).toBeEnabled();
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("pay page: a full page load under its nonce CSP; a declined card, then a test payment that sells nothing", async ({
  page,
}) => {
  const buyer = uniqueBuyer("preview");
  const payPagePolicies: string[] = [];
  page.on("response", (r) => {
    if (
      r.request().resourceType() === "document" &&
      r.url().includes("/checkout/pay/")
    ) {
      payPagePolicies.push(r.headers()["content-security-policy"] ?? "");
    }
  });

  await page.goto(checkoutUrl(SLUG, { ship: "LOCAL_PICKUP" }));
  await fillCheckout(page, { locale: "en", ...buyer });
  await page.getByTestId("checkout-submit").click();
  await expect(page).toHaveURL(/\/en\/checkout\/pay\/[0-9a-f-]{36}\?t=/);

  // Our own pay page, opened with a full page load: its own policy, with a nonce and PayMe only.
  const navigation = await page.evaluate(
    () =>
      (
        performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming
      ).name,
  );
  expect(navigation).toContain("/checkout/pay/");
  expect(payPagePolicies.at(-1)).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  await expect(page.getByTestId("pay-test-banner")).toHaveText(
    checkout.pay.testBanner,
  );
  await expect(page.getByTestId("summary-line")).toHaveCount(1);
  expect(await seriousAxeViolations(page)).toEqual([]);

  // Nothing filled in: the holder's details are checked here, before Isracard is asked.
  const fieldErrors = checkout.pay.fieldErrors;
  await expect(page.getByTestId("pay-submit")).toBeEnabled();
  await page.getByTestId("pay-submit").click();
  expect(await summaryItems(page)).toEqual([
    fieldErrors.firstName,
    fieldErrors.lastName,
    fieldErrors.email,
    fieldErrors.phone,
  ]);
  await expect(holderBox(page, checkout.pay.firstName)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  // The holder is fine but the card is empty: Isracard's fields name what to fix.
  await fillHolder(page, buyer);
  await holderBox(page, checkout.pay.socialId).fill("123456789");
  await page.getByTestId("pay-submit").click();
  expect(await summaryItems(page)).toEqual([fieldErrors.socialId]);
  await holderBox(page, checkout.pay.socialId).fill("008336174");
  await page.getByTestId("pay-submit").click();
  expect(await summaryItems(page)).toEqual([
    fieldErrors.cardNumber,
    fieldErrors.cardExpiration,
    fieldErrors.cvc,
  ]);
  expect(
    (await (
      await page.request.get(`${test.info().config.metadata.paymeStub}/__log`)
    ).json()) as StubRequest[],
  ).not.toContainEqual(expect.objectContaining({ path: "/api/generate-sale" }));

  // A refused try spends the one-time token: the card fields come back empty, in a new session.
  await page
    .locator('input[name="installments"]')
    .evaluate((el: HTMLInputElement) => {
      el.value = "2"; // more payments than this order allows
    });
  await fillCard(page, TEST_CARD);
  await page.getByTestId("pay-submit").click();
  await expect(page.getByTestId("pay-error")).toHaveText(
    checkout.pay.errors.invalid,
  );
  await expect(page.locator("[data-stub-field=cardNumber]")).toHaveCount(1);
  await expect(page.locator("[data-stub-field=cardNumber]")).toHaveValue("");
  await page
    .locator('input[name="installments"]')
    .evaluate((el: HTMLInputElement) => {
      el.value = "1";
    });

  // A declined card: nothing charged, a new pay page says so.
  await payWith(page, DECLINED_CARD, buyer);
  await expect(page).toHaveURL(/\/en\/checkout\/pay\/[^?]+\?t=.*declined=1/);
  await expect(page.getByTestId("pay-declined")).toHaveText(
    checkout.pay.declined,
  );

  // Isracard's test card: verified with the provider, and closed as a test.
  await payWith(page, TEST_CARD, buyer);
  await expect(page).toHaveURL(
    /\/en\/orders\/GG-[0-9A-Z]{6}\?k=.*payment=test_payment/,
  );
  await expect(page.getByTestId("payment-result")).toContainText(
    orders.payment.test_payment,
  );

  // Nothing was sold: the work is available, the order expired as a test, no sale was recorded.
  const number = (await page.getByTestId("order-number").textContent())?.trim();
  expect(await artworkStatus(SLUG)).toEqual({
    sale_status: "AVAILABLE",
    reserved_by_order_id: null,
  });
  const [order] = await e2eQuery<{
    id: string;
    status: string;
    status_reason: string | null;
    total_minor: number;
  }>(
    "SELECT id, status, status_reason, total_minor FROM orders WHERE number = $1",
    [number],
  );
  expect(order).toMatchObject({
    status: "EXPIRED",
    status_reason: "TEST_PAYMENT",
  });
  expect(
    await e2eQuery("SELECT id FROM sales WHERE order_id = $1", [order?.id]),
  ).toHaveLength(0);
  const attempts = await e2eQuery<{ status: string; provider_mode: string }>(
    `SELECT status, provider_mode FROM payment_attempts WHERE order_id = $1 ORDER BY seq`,
    [order?.id],
  );
  expect(attempts).toEqual([
    { status: "FAILED", provider_mode: "TEST" },
    { status: "CANCELED", provider_mode: "TEST" },
  ]);

  // What the server sent PayMe: the order's amount, marked as a test, and only a one-time token.
  const stub = test.info().config.metadata.paymeStub as string;
  const log = (await (
    await page.request.get(`${stub}/__log`)
  ).json()) as StubRequest[];
  const sales = log.filter(
    (r) =>
      r.path === "/api/generate-sale" &&
      String(r.body.product_name).includes(number ?? "-"),
  );
  expect(sales).toHaveLength(2);
  for (const s of sales) {
    expect(s.body).toMatchObject({
      sale_price: order?.total_minor,
      currency: "ILS",
    });
    expect(String(s.body.product_name)).toMatch(/^TEST – /);
  }
  const ids = new Set(sales.map((s) => s.saleId));
  const charges = log.filter(
    (r) => r.path === "/api/pay-sale" && ids.has(String(r.body.payme_sale_id)),
  );
  expect(charges.map((c) => c.body.buyer_key)).toEqual([
    "BUYER-STUB-0002",
    "BUYER-STUB-5846",
  ]);
  const sent = JSON.stringify([...sales, ...charges]);
  expect(sent).not.toContain(TEST_CARD);
  expect(sent).not.toContain(DECLINED_CARD);
});
