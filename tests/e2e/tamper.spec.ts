import { expect, test } from "@playwright/test";
import pg from "pg";
import { uniqueBuyer } from "../helpers/factories/core";
import { buildMockWebhook } from "../helpers/mock-webhook";
import { E2E_SECRETS } from "./e2e-env";
import {
  artworkStatus,
  buyerIp,
  cloneWork,
  continueToMockPay,
  e2eDatabaseUrl,
  e2eQuery,
  fillCheckout,
  messages,
  orderStatusByRef,
} from "./support/commerce";

/**
 * Spec §10.4 `tamper` (§5.3 #4, #13, #26): duplicate and concurrent webhooks produce exactly one
 * sale; a payment whose amount differs from the order (tampered at the provider) is never applied
 * (MANUAL_REQUIRED refund + CRITICAL alert); a tampered total in the form is answered with
 * "price changed" and nothing is written.
 */
const enCheckout = messages("en", "checkout");

test.use({ extraHTTPHeaders: buyerIp(27) });
test.beforeAll(async () => {
  await cloneWork("still-life-no-15", "e2e-tamper-dup");
  await cloneWork("still-life-no-15", "e2e-tamper-amount");
  await cloneWork("still-life-no-15", "e2e-tamper-form");
});

test("duplicate and concurrent webhooks → exactly one sale", async ({
  page,
  request,
  baseURL,
}) => {
  const slug = "e2e-tamper-dup";
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...uniqueBuyer("dup") });
  const ref = await continueToMockPay(page);
  await page.getByTestId("mock-pay_no_return").click();
  await expect(page.getByTestId("mock-state")).toHaveText("PAID");

  const sends = [];
  for (const eventId of ["evt_dup_a", "evt_dup_a", "evt_dup_b", "evt_dup_c"]) {
    const req = buildMockWebhook({
      baseUrl: baseURL ?? "",
      ref,
      secret: E2E_SECRETS.MOCK_WEBHOOK_SECRET,
      eventId: `${eventId}_${ref.slice(-6)}`,
    });
    sends.push(request.post(req.url, { data: req.body, headers: req.headers }));
  }
  const statuses = (await Promise.all(sends)).map((r) => r.status());
  expect(statuses.every((s) => s === 200)).toBe(true);
  await expect.poll(() => orderStatusByRef(ref)).toBe("PAID");

  const sales = await e2eQuery<{ n: string }>(
    `SELECT count(*) AS n FROM sales s JOIN artworks a ON a.id = s.artwork_id
      WHERE a.slug = $1 AND s.voided_at IS NULL`,
    [slug],
  );
  expect(Number(sales[0]?.n)).toBe(1);
  const receipts = await e2eQuery<{ n: string }>(
    `SELECT count(*) AS n FROM outbox_jobs j JOIN payment_attempts pa
        ON j.dedupe_key = 'taxdoc:receipt:' || pa.id WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(Number(receipts[0]?.n)).toBe(1);
});

test("an amount tampered at the provider is never applied: manual refund and a CRITICAL alert", async ({
  page,
}) => {
  const slug = "e2e-tamper-amount";
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...uniqueBuyer("amount") });
  const ref = await continueToMockPay(page);

  // Simulate a provider-side amount that differs from the order (the mock's own record).
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      "UPDATE mock_payments SET amount_minor = amount_minor - 100 WHERE ref = $1",
      [ref],
    );
  } finally {
    await client.end();
  }
  await page.reload();
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=needs_refund/);

  expect(await orderStatusByRef(ref)).toBe("AWAITING_PAYMENT");
  expect((await artworkStatus(slug))?.sale_status).toBe("AVAILABLE");
  const [refund] = await e2eQuery<{ reason: string; status: string }>(
    `SELECT r.reason, r.status FROM refunds r JOIN payment_attempts pa ON pa.id = r.attempt_id
      WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(refund).toEqual({
    reason: "AMOUNT_MISMATCH",
    status: "MANUAL_REQUIRED",
  });
  const [alert] = await e2eQuery<{ severity: string }>(
    `SELECT a.severity FROM admin_alerts a JOIN payment_attempts pa ON pa.id = a.entity_id::uuid
      WHERE a.kind = 'PAYMENT_NEEDS_REFUND' AND pa.provider_ref = $1`,
    [ref],
  );
  expect(alert?.severity).toBe("CRITICAL");
});

test("a tampered total in the form → price changed, nothing written", async ({
  page,
}) => {
  const slug = "e2e-tamper-form";
  const buyer = uniqueBuyer("form");
  await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
  await fillCheckout(page, { locale: "en", ...buyer });
  await page.locator('input[name="expectedTotalMinor"]').evaluate((el) => {
    (el as HTMLInputElement).value = "100";
  });
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("checkout-error")).toContainText(
    enCheckout.errors.price_changed,
  );
  expect(
    await e2eQuery("SELECT 1 FROM orders WHERE buyer_email = $1", [
      buyer.email,
    ]),
  ).toHaveLength(0);
  expect((await artworkStatus(slug))?.reserved_by_order_id).toBeNull();
});
