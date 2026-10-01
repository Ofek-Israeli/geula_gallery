import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  buyerIp,
  cloneWork,
  continueToMockPay,
  e2eQuery,
  messages,
} from "./support/commerce";

/**
 * Spec §10.4 `international`: a US destination needs a Latin-script address and the DAP
 * acknowledgement; the buyer can switch to USD, sees every amount (including the insured value) in
 * dollars and pays the USD total.
 */
const en = messages("en", "checkout");
const enOrders = messages("en", "orders");
const common = messages("en", "common");
const SLUG = "e2e-intl-1";

test.use({ extraHTTPHeaders: buyerIp(21) });
test.beforeAll(async () => cloneWork("movement-no-10", SLUG));

test("US buyer: Latin address and DAP required, pays the USD total", async ({
  page,
}) => {
  await page.goto(`/en/checkout/${SLUG}?to=US`);
  await expect(page.getByTestId("checkout-total")).toContainText("₪");
  // Switch to dollars through the delivery form.
  await page.getByLabel(en.delivery.currencyUsd).check();
  await page.getByRole("button", { name: en.delivery.update }).click();
  await expect(page).toHaveURL(/cur=USD/);
  await expect(page.getByTestId("checkout-total")).toContainText("$");
  await expect(page.getByTestId("checkout-summary")).not.toContainText("₪");
  await expect(
    page.getByRole("group", { name: en.delivery.methodLegend }),
  ).not.toContainText("₪");
  await expect(page.getByText(en.notices.DAP_DUTIES)).toBeVisible();

  const buyer = uniqueBuyer("intl");
  const box = (label: string) =>
    page.getByRole("textbox", { name: new RegExp(`^${label}`) });
  await box(en.details.name).fill("ישראל ישראלי");
  await box(en.details.email).fill(buyer.email);
  await box(en.details.phone).fill("+12025550123");
  await box(en.details.line1).fill("רחוב הרצל 1");
  await box(en.details.city).fill("Springfield");
  await box(en.details.postalCode).fill("62701");
  await page.getByLabel(en.consent.terms).check();
  await page.getByLabel(en.consent.age).check();
  // DAP left unticked.
  await page.getByTestId("checkout-submit").click();

  const latin =
    "Please use Latin (English) characters for international shipping";
  await expect(page.getByText(latin).first()).toBeVisible();
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
    duties_ack_at: Date | null;
    total_minor: number;
    amount_minor: number;
  }>(
    `SELECT o.currency, o.ship_country, o.ship_line1, o.duties_ack_at, o.total_minor, pa.amount_minor
       FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(order).toMatchObject({
    currency: "USD",
    ship_country: "US",
    ship_line1: "1 Main Street",
  });
  expect(order?.duties_ack_at).not.toBeNull();
  expect(order?.amount_minor).toBe(order?.total_minor);
  expect(common.form.optional).toBeTruthy();
});
