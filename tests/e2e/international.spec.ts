import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  buyerIp,
  chooseDelivery,
  chooseDestination,
  cloneWork,
  continueToMockPay,
  e2eQuery,
  messages,
} from "./support/commerce";

/**
 * Spec §10.4 `international`: a US destination needs a Latin-script city and postal code (step 1),
 * then a Latin-script street address and the DAP acknowledgement (step 3); the buyer switches to
 * USD on the delivery step, sees every amount (including the insured value) in dollars and pays
 * the USD total. City and postal code are typed once, on step 1. The courier abroad is priced by
 * the DHL Express estimate (named "DHL Express"; its workings are stored with the order's quote);
 * amounts are pinned by the unit tests, not here.
 */
const en = messages("en", "checkout");
const enOrders = messages("en", "orders");
const SLUG = "e2e-intl-1";
const LATIN =
  "Please use Latin (English) characters for international shipping";

test.use({ extraHTTPHeaders: buyerIp(21) });
test.beforeAll(async () => cloneWork("blue-and-yellow-notes", SLUG));

test("US buyer: Latin destination and address, DAP required, pays the USD total", async ({
  page,
}) => {
  await page.goto(`/en/checkout/${SLUG}?to=US`);

  // Step 1: the destination, the country taken from the link; a Hebrew city is refused.
  await expect(page.locator("#co-country")).toHaveValue("US");
  await chooseDestination(page, {
    locale: "en",
    city: "ספרינגפילד",
    zip: "62701",
  });
  const destination = page.getByTestId("checkout-destination");
  await expect(destination.getByRole("alert")).toContainText(LATIN);
  await expect(page.locator("#co-city")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await chooseDestination(page, {
    locale: "en",
    city: "Springfield",
    zip: "62701",
  });

  // Step 2: priced in shekels, then in dollars through the currency links.
  const methods = page.getByRole("group", { name: en.delivery.methodLegend });
  await expect(methods).toContainText("₪");
  await expect(methods).toContainText(en.delivery.method.DHL_EXPRESS);
  const usd = page
    .getByTestId("currency-toggle")
    .getByRole("link", { name: en.delivery.currencyUsd });
  await usd.click();
  await expect(page).toHaveURL(/cur=USD/);
  await expect(usd).toHaveAttribute("aria-current", "true");
  await expect(methods).not.toContainText("₪");
  await expect(methods).toContainText("$");
  await expect(page.getByText(en.notices.DAP_DUTIES).first()).toBeVisible();
  await chooseDelivery(page, { locale: "en", method: "CARRIER_TABLE" });

  // Step 3: dollars everywhere, and no city or postal code to type again.
  await expect(page.getByTestId("checkout-form")).toBeVisible();
  await expect(page.getByTestId("checkout-total")).toContainText("$");
  await expect(page.getByTestId("checkout-summary")).not.toContainText("₪");
  const box = (label: string) =>
    page.getByRole("textbox", { name: new RegExp(`^${label}`) });
  await expect(box(en.details.city)).toHaveCount(0);
  await expect(box(en.details.postalCode)).toHaveCount(0);
  await expect(page.getByTestId("details-destination")).toContainText(
    "Springfield 62701",
  );

  const buyer = uniqueBuyer("intl");
  await box(en.details.name).fill("ישראל ישראלי");
  await box(en.details.email).fill(buyer.email);
  await box(en.details.phone).fill("+12025550123");
  await box(en.details.line1).fill("רחוב הרצל 1");
  await page.getByLabel(en.consent.terms).check();
  await page.getByLabel(en.consent.age).check();
  // DAP left unticked.
  await page.getByTestId("checkout-submit").click();

  await expect(page.getByText(LATIN).first()).toBeVisible();
  await expect(page.getByText(en.consent.required).first()).toBeVisible();
  expect(page.url()).toContain(`/en/checkout/${SLUG}`);
  expect(
    await e2eQuery("SELECT 1 FROM orders WHERE buyer_email = $1", [
      buyer.email,
    ]),
  ).toHaveLength(0);

  await box(en.details.name).fill("Jane Doe");
  await box(en.details.line1).fill("1 Main Street");
  await page.getByLabel(en.consent.dap).check();
  const ref = await continueToMockPay(page);
  await expect(page.getByTestId("mock-amount")).toContainText("$");
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.PAID,
  );
  await expect(page.getByTestId("order-page")).toContainText("$");

  const [order] = await e2eQuery<{
    currency: string;
    ship_country: string;
    ship_line1: string;
    ship_city: string;
    ship_postal_code: string;
    duties_ack_at: Date | null;
    total_minor: number;
    amount_minor: number;
    rate_source: string | null;
    dhl_zone: string | null;
  }>(
    `SELECT o.currency, o.ship_country, o.ship_line1, o.ship_city, o.ship_postal_code,
            o.duties_ack_at, o.total_minor, pa.amount_minor,
            o.shipping_quote->>'rateSource' AS rate_source,
            o.shipping_quote->'dhl'->>'zone' AS dhl_zone
       FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(order).toMatchObject({
    currency: "USD",
    ship_country: "US",
    ship_line1: "1 Main Street",
    ship_city: "Springfield",
    ship_postal_code: "62701",
    // The locked quote carries the DHL estimate's workings (US = DHL zone 1).
    rate_source: "DHL_ESTIMATE",
    dhl_zone: "1",
  });
  expect(order?.duties_ack_at).not.toBeNull();
  expect(order?.amount_minor).toBe(order?.total_minor);
});
