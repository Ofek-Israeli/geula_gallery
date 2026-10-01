import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  anotherBuyerBuys,
  artworkStatus,
  buyerIp,
  cloneWork,
  continueToMockPay,
  drainOutbox,
  e2eQuery,
  fillCheckout,
  mailbox,
  messages,
  releaseFromSecondTab,
} from "./support/commerce";

/**
 * Spec §10.4 `capture-mode` (§5.2 `requires_capture`, `review`): an approval is captured by the
 * shop once the claim succeeds; an approval that arrives after the work was sold is never
 * captured ("you were not charged"); while a payment is under review the order page offers no new
 * payment and no release, and the work stays reserved.
 */
const enOrders = messages("en", "orders");
const enCheckout = messages("en", "checkout");

test.use({ extraHTTPHeaders: buyerIp(24) });
test.beforeAll(async () => {
  await cloneWork("still-life-no-15", "e2e-capture-ok");
  await cloneWork("still-life-no-15", "e2e-capture-lost");
  await cloneWork("still-life-no-15", "e2e-capture-review");
});

async function mockState(ref: string) {
  const [row] = await e2eQuery<{
    state: string;
    capture_request_ids: string[];
  }>("SELECT state, capture_request_ids FROM mock_payments WHERE ref = $1", [
    ref,
  ]);
  return row;
}

test("approve → the shop captures → paid", async ({ page }) => {
  const slug = "e2e-capture-ok";
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...uniqueBuyer("capture") });
  const ref = await continueToMockPay(page);
  await page.getByTestId("mock-approve").click();
  await expect(page).toHaveURL(/payment=paid/);
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.PAID,
  );
  const mock = await mockState(ref);
  expect(mock?.state).toBe("PAID");
  expect(mock?.capture_request_ids).toHaveLength(1);
  expect((await artworkStatus(slug))?.sale_status).toBe("SOLD");
});

test("an approval after the work was sold is never captured", async ({
  page,
  request,
}) => {
  const slug = "e2e-capture-lost";
  const buyer = uniqueBuyer("capture-lost");
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...buyer });
  const ref = await continueToMockPay(page);
  await releaseFromSecondTab(page, ref);
  await anotherBuyerBuys(page, slug, 25);

  await page.getByTestId("mock-approve").click();
  await expect(page).toHaveURL(/payment=lost_before_capture/);
  await expect(page.getByTestId("payment-result")).toHaveText(
    enOrders.payment.lost_before_capture,
  );
  const mock = await mockState(ref);
  expect(mock?.state).toBe("APPROVED");
  expect(mock?.capture_request_ids ?? []).toHaveLength(0);
  const [attempt] = await e2eQuery<{ status: string }>(
    "SELECT status FROM payment_attempts WHERE provider_ref = $1",
    [ref],
  );
  expect(attempt?.status).toBe("CANCELED");

  await drainOutbox(request);
  const [mail] = await mailbox.waitFor({
    to: buyer.email,
    template: "purchase-not-completed",
  });
  expect(mail?.text ?? "").toContain("You were not charged");
});

test("under review: no new payment, no release, the work stays reserved", async ({
  page,
  browser,
  baseURL,
}) => {
  const slug = "e2e-capture-review";
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...uniqueBuyer("review") });
  await continueToMockPay(page);
  await page.getByTestId("mock-review").click();
  await expect(page).toHaveURL(/payment=review/);
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.PAYMENT_REVIEW,
  );
  await expect(page.getByText(enOrders.review.body)).toBeVisible();
  await expect(page.getByTestId("pay-now")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: enOrders.release }),
  ).toHaveCount(0);

  // Another buyer cannot start a checkout for the reserved work.
  const ctx = await browser.newContext({
    extraHTTPHeaders: buyerIp(26),
    baseURL,
  });
  const other = await ctx.newPage();
  await other.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await expect(other.getByTestId("checkout-blocked")).toContainText(
    enCheckout.blocked.RESERVED,
  );
  await ctx.close();
});
