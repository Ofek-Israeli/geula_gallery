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
 * Spec §10.4 `late-payment` (§5.3 #8, #9): the buyer's hold is gone while the provider page is still
 * open. If someone else bought the work meanwhile, the late payment is refunded automatically with
 * the `purchase-not-completed` email and a CRITICAL alert; if the work is still free, the late
 * payment completes the order.
 */
const enOrders = messages("en", "orders");

test.use({ extraHTTPHeaders: buyerIp(22) });
test.beforeAll(async () => {
  await cloneWork("still-life-no-15", "e2e-late-lost");
  await cloneWork("still-life-no-15", "e2e-late-free");
});

test("hold lost to another buyer → the late payment is refunded with an email and an alert", async ({
  page,
  request,
}) => {
  const slug = "e2e-late-lost";
  const buyer = uniqueBuyer("late-lost");
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...buyer });
  const ref = await continueToMockPay(page);

  await releaseFromSecondTab(page, ref);
  await anotherBuyerBuys(page, slug, 23);
  expect((await artworkStatus(slug))?.sale_status).toBe("SOLD");

  // The first buyer finally pays on the page that stayed open.
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=needs_refund/);
  await expect(page.getByTestId("payment-result")).toHaveText(
    enOrders.payment.needs_refund,
  );
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.CANCELLED,
  );

  await drainOutbox(request);
  const [refund] = await e2eQuery<{
    reason: string;
    status: string;
    amount_minor: number;
  }>(
    `SELECT r.reason, r.status, r.amount_minor FROM refunds r
       JOIN payment_attempts pa ON pa.id = r.attempt_id WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(refund).toMatchObject({
    reason: "LOST_RESERVATION",
    status: "SUCCEEDED",
  });
  const [mock] = await e2eQuery<{ state: string }>(
    "SELECT state FROM mock_payments WHERE ref = $1",
    [ref],
  );
  expect(mock?.state).toBe("REFUNDED");
  const mail = await mailbox.waitFor({
    to: buyer.email,
    template: "purchase-not-completed",
  });
  expect(mail[0]?.subject).toContain("could not be completed");
  const alerts = await e2eQuery<{ severity: string }>(
    `SELECT a.severity FROM admin_alerts a JOIN payment_attempts pa ON pa.id = a.entity_id::uuid
      WHERE a.kind = 'PAYMENT_NEEDS_REFUND' AND pa.provider_ref = $1`,
    [ref],
  );
  expect(alerts[0]?.severity).toBe("CRITICAL");
});

test("hold lapsed but the work is still free → the late payment completes the order", async ({
  page,
}) => {
  const slug = "e2e-late-free";
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...uniqueBuyer("late-free") });
  const ref = await continueToMockPay(page);
  await releaseFromSecondTab(page, ref);
  expect((await artworkStatus(slug))?.reserved_by_order_id).toBeNull();

  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.PAID,
  );
  expect((await artworkStatus(slug))?.sale_status).toBe("SOLD");
});
