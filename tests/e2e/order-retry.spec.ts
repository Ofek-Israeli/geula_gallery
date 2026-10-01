import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  buyerIp,
  continueToMockPay,
  fillCheckout,
  messages,
} from "./support/commerce";

/**
 * Spec §10.4 `order-retry` (M2 acceptance): a cancelled payment returns the buyer to the order page
 * with the hold intact; "Pay now" starts a new attempt that succeeds; "Release my reservation"
 * frees the work at once.
 */
const enOrders = messages("en", "orders");
const enArtwork = messages("en", "artwork");
const heOrders = messages("he", "orders");
const heArtwork = messages("he", "artwork");
const heCommon = messages("he", "common");

test.use({ extraHTTPHeaders: buyerIp(13) });

test("cancel at the provider → retry from the order page → paid", async ({
  page,
}) => {
  const slug = "still-life-no-15";
  const buyer = uniqueBuyer("retry");
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...buyer });
  const firstRef = await continueToMockPay(page);
  await page.getByTestId("mock-cancel").click();

  await expect(page).toHaveURL(
    /\/en\/orders\/GG-[0-9A-Z]{6}\?k=.*payment=canceled/,
  );
  await expect(page.getByTestId("payment-result")).toHaveText(
    enOrders.payment.canceled,
  );
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.AWAITING_PAYMENT,
  );
  // Still reserved for this buyer.
  await expect(page.getByText(/Reserved for you until/)).toBeVisible();

  await page.getByTestId("pay-now").click();
  await expect(page).toHaveURL(/\/en\/mock-pay\/mock_[0-9a-f]{32}/);
  expect(page.url()).not.toContain(firstRef);
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.PAID,
  );
  await expect(page.getByTestId("order-attempts")).toContainText(
    enOrders.attempts.status.CANCELED,
  );
  await page.goto(`/en/works/${slug}`);
  await expect(page.getByTestId("artwork-status")).toHaveText(
    enArtwork.status.sold,
  );
});

test("release my reservation → the work is available again (Hebrew)", async ({
  page,
}) => {
  const slug = "beach-les-grands-sables";
  const buyer = uniqueBuyer("release");
  await page.goto(`/he/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "he", ...buyer });
  await continueToMockPay(page);
  await page.getByTestId("mock-cancel").click();
  await expect(page).toHaveURL(/\/he\/orders\/GG-[0-9A-Z]{6}\?k=/);

  await page.getByRole("button", { name: heOrders.release }).click();
  await page
    .getByRole("button", { name: heCommon.form.confirm, exact: true })
    .click();
  await expect(page.getByText(heOrders.released)).toBeVisible();
  await expect(page.getByTestId("order-status")).toHaveText(
    heOrders.status.EXPIRED,
  );

  await page.goto(`/he/works/${slug}`);
  await expect(page.getByTestId("artwork-status")).toHaveText(
    heArtwork.status.available,
  );
});
