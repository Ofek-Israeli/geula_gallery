import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import { buildMockWebhook } from "../helpers/mock-webhook";
import { E2E_SECRETS } from "./e2e-env";
import {
  buyerIp,
  continueToMockPay,
  e2eQuery,
  fillCheckout,
  messages,
  orderStatusByRef,
} from "./support/commerce";

/**
 * Spec §10.4 `webhook` (M2 acceptance): "Pay without returning" is settled by the signed webhook
 * alone; forged and unsigned webhooks are refused with 401 before anything is written; a valid
 * webhook for a payment that was not made leaves the order unpaid (the webhook is only a hint —
 * finalization re-queries the provider).
 */
const enArtwork = messages("en", "artwork");
const enOrders = messages("en", "orders");

test.use({ extraHTTPHeaders: buyerIp(12) });

test("Pay without returning: the webhook alone marks the order paid", async ({
  page,
}) => {
  const slug = "still-life-green-flower-vase";
  const buyer = uniqueBuyer("webhook-pay");
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...buyer });
  const ref = await continueToMockPay(page);
  await page.getByTestId("mock-pay_no_return").click();
  // The buyer stays on the provider's page.
  await expect(page).toHaveURL(new RegExp(`/en/mock-pay/${ref}\\?done=1`));
  await expect(page.getByTestId("mock-state")).toHaveText("PAID");
  await expect
    .poll(() => orderStatusByRef(ref), { timeout: 20_000 })
    .toBe("PAID");
  await page.goto(`/en/works/${slug}`);
  await expect(page.getByTestId("artwork-status")).toHaveText(
    enArtwork.status.sold,
  );
});

test("forged, unsigned and stale webhooks get 401 and write nothing", async ({
  request,
  baseURL,
}) => {
  const count = async () =>
    Number(
      (
        await e2eQuery<{ n: string }>(
          "SELECT count(*) AS n FROM payment_events",
        )
      )[0]?.n ?? 0,
    );
  const before = await count();
  const ref = `mock_${"0".repeat(32)}`;
  for (const variant of [
    { signWith: "e2e-not-the-secret" },
    { unsigned: true },
    { timestamp: Math.floor(Date.now() / 1000) - 3600 },
  ]) {
    const req = buildMockWebhook({
      baseUrl: baseURL ?? "",
      ref,
      secret: E2E_SECRETS.MOCK_WEBHOOK_SECRET,
      ...variant,
    });
    const res = await request.post(req.url, {
      data: req.body,
      headers: req.headers,
    });
    expect(res.status(), JSON.stringify(variant)).toBe(401);
  }
  expect(await count()).toBe(before);
});

test("a valid webhook for an unpaid payment leaves the order unpaid", async ({
  page,
  request,
  baseURL,
}) => {
  const slug = "a-holiday";
  const buyer = uniqueBuyer("webhook-unpaid");
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...buyer });
  const ref = await continueToMockPay(page);

  const req = buildMockWebhook({
    baseUrl: baseURL ?? "",
    ref,
    secret: E2E_SECRETS.MOCK_WEBHOOK_SECRET,
  });
  const res = await request.post(req.url, {
    data: req.body,
    headers: req.headers,
  });
  expect(res.status()).toBe(200);
  expect(await orderStatusByRef(ref)).toBe("AWAITING_PAYMENT");
  await page.reload();
  await expect(page.getByTestId("mock-state")).toHaveText("OPEN");

  // Leave the work free again: cancel at the provider, then release the hold.
  await page.getByTestId("mock-cancel").click();
  await expect(page).toHaveURL(/\/en\/orders\/GG-[0-9A-Z]{6}\?k=/);
  await expect(page.getByTestId("order-status")).toHaveText(
    enOrders.status.AWAITING_PAYMENT,
  );
  await page.getByRole("button", { name: enOrders.release }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(enOrders.released)).toBeVisible();
  await page.goto(`/en/works/${slug}`);
  await expect(page.getByTestId("artwork-status")).toHaveText(
    enArtwork.status.available,
  );
});
