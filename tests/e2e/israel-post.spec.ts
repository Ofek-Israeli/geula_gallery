import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  buyerIp,
  checkoutUrl,
  chooseDelivery,
  chooseDestination,
  cloneWork,
  continueToMockPay,
  e2eQuery,
  fillCheckout,
  messages,
} from "./support/commerce";

/**
 * Israel Post at its published prices: home delivery in Israel (bought end to end, so the order
 * and its shipment carry the ISRAEL_POST method), and EMS next to DHL Express abroad. Each test has
 * its own clone of "puzzle" (an 80×60 canvas: 92×72×11 cm, 4.38 kg packed, within Israel Post's
 * limits), so the purchase does not affect the other test.
 */
const en = messages("en", "checkout");
const DOMESTIC = "e2e-post-il";
const ABROAD = "e2e-post-abroad";

test.use({ extraHTTPHeaders: buyerIp(31) });
test.beforeAll(async () => {
  await cloneWork("puzzle", DOMESTIC);
  await cloneWork("puzzle", ABROAD);
});

test("Israel: home delivery by Israel Post at ₪73, paid, shipped by hand", async ({
  page,
}) => {
  const buyer = uniqueBuyer("israel-post");
  await page.goto(`/en/checkout/${DOMESTIC}`);
  await chooseDestination(page, {
    locale: "en",
    city: "Haifa",
    zip: "3100000",
  });
  const post = page.getByRole("radio", {
    name: new RegExp(`^${en.delivery.method.ISRAEL_POST}`),
  });
  await expect(post).toBeVisible();
  await expect(
    page.getByTestId("delivery-form").getByText(/₪73/),
  ).toBeVisible();
  await chooseDelivery(page, { locale: "en", method: "ISRAEL_POST" });
  await expect(page.getByTestId("checkout-recap")).toContainText(
    en.delivery.method.ISRAEL_POST,
  );
  await fillCheckout(page, {
    locale: "en",
    name: buyer.name,
    email: buyer.email,
    address: true,
  });
  const ref = await continueToMockPay(page);
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);

  const [order] = await e2eQuery<{
    shipping_method: string;
    shipping_minor: number;
    rate_source: string | null;
    service: string | null;
    ship_city: string | null;
    shipment_method: string | null;
    shipment_carrier: string | null;
  }>(
    `SELECT o.shipping_method, o.shipping_minor, o.shipping_quote->>'rateSource' AS rate_source,
            o.shipping_quote->'israelPost'->>'service' AS service, o.ship_city,
            s.method AS shipment_method, s.carrier AS shipment_carrier
       FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
       LEFT JOIN shipments s ON s.order_id = o.id
      WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(order).toMatchObject({
    shipping_method: "ISRAEL_POST",
    shipping_minor: 7300,
    rate_source: "ISRAEL_POST",
    service: "DOMESTIC_DOOR",
    ship_city: "Haifa",
  });
  // Payment creates the shipment: Israel Post, booked and tracked by hand.
  expect(order).toMatchObject({
    shipment_method: "ISRAEL_POST",
    shipment_carrier: "MANUAL",
  });
});

test("abroad: Israel Post EMS next to DHL Express", async ({ page }) => {
  await page.goto(
    checkoutUrl(ABROAD, {
      to: "CA",
      city: "Toronto",
      zip: "M5V 2T6",
      step: "delivery",
    }),
  );
  const form = page.getByTestId("delivery-form");
  await expect(
    form.getByRole("radio", {
      name: new RegExp(`^${en.delivery.method.ISRAEL_POST_EMS}`),
    }),
  ).toBeVisible();
  await expect(
    form.getByRole("radio", {
      name: new RegExp(`^${en.delivery.method.DHL_EXPRESS}`),
    }),
  ).toBeVisible();
  // EMS to Canada (group 4): 4.38 kg → 4.5 kg, ₪171 + 7 × ₪24 = ₪339, plus the EMS insurance:
  // ₪6.90 per ₪1,000 or part of the work's value (insured up to ₪10,000).
  const [work] = await e2eQuery<{ price: number }>(
    "SELECT price_ils_minor AS price FROM artworks WHERE slug = $1",
    [ABROAD],
  );
  const insured = Math.min(work?.price ?? 0, 1_000_000);
  const totalMinor = 33_900 + Math.ceil(insured / 100_000) * 690;
  const price = `₪${(totalMinor / 100).toLocaleString("en", {
    minimumFractionDigits: totalMinor % 100 ? 2 : 0,
  })}`;
  await expect(form.getByText(price)).toBeVisible();
});
