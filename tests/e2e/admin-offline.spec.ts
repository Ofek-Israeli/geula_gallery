import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  adminContext,
  createPublishedArtwork,
  field,
  HE,
  submitWithConfirm,
} from "./support/admin";
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
 * Spec §10.4 `admin-offline` (spec §5.9): an offline hold toggles the public status and the admin
 * badge; an offline sale while a buyer is checking out asks for confirmation, expires that order,
 * and the buyer's later payment is refunded automatically.
 */
const c = HE.catalog;
const heArtwork = messages("he", "artwork");

test.use({ extraHTTPHeaders: buyerIp(41) });

test("offline hold toggles the badge; an offline sale during a hold → the later payment is refunded", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const admin = await adminContext(browser);
  try {
    const ap = await admin.newPage();
    const a = await createPublishedArtwork(ap, { prefix: "Offline sale" });

    // Hold: the public page says "reserved", the admin list badge says "on hold".
    const hold = ap.getByTestId("offline-hold-form");
    await field(hold, c.sale.note).fill("Studio visit on Friday");
    await hold.getByRole("button", { name: c.sale.holdSubmit }).click();
    await expect(ap.getByTestId("artwork-sale-status")).toHaveText(
      c.status.ON_HOLD,
    );
    await page.goto(`/he/works/${a.slug}`);
    await expect(page.getByTestId("artwork-status")).toHaveText(
      heArtwork.status.reservedOffline,
    );
    await ap.goto(`/he/admin/artworks?q=${encodeURIComponent(a.titleEn)}`);
    await expect(ap.getByTestId("admin-artwork-status")).toHaveText(
      c.status.ON_HOLD,
    );
    await ap.goto(`/he/admin/artworks/${a.id}`);
    await ap
      .getByTestId("release-hold-form")
      .getByRole("button", { name: c.sale.release })
      .click();
    await expect(ap.getByTestId("artwork-sale-status")).toHaveText(
      c.status.AVAILABLE,
    );
    await page.goto(`/he/works/${a.slug}`);
    await expect(page.getByTestId("artwork-status")).toHaveText(
      heArtwork.status.available,
    );

    // A buyer starts checking out (the work is held for them).
    const buyer = uniqueBuyer("offline");
    await page.goto(`/he/checkout/${a.slug}?ship=LOCAL_PICKUP`);
    await fillCheckout(page, {
      locale: "he",
      name: buyer.name,
      email: buyer.email,
    });
    const ref = await continueToMockPay(page);

    // Meanwhile the painter sells it in the studio: the override dialog names the hold.
    await ap.goto(`/he/admin/artworks/${a.id}`);
    await expect(ap.getByTestId("artwork-live-hold")).toBeVisible();
    const sold = ap.getByTestId("sold-offline-form");
    await submitWithConfirm(sold, c.sale.soldSubmit, c.sale.overrideConfirm);
    await expect(ap.getByTestId("artwork-sale-status")).toHaveText(
      c.status.SOLD,
    );
    const [expired] = await e2eQuery<{ status: string; status_reason: string }>(
      `SELECT o.status, o.status_reason FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
        WHERE pa.provider_ref = $1`,
      [ref],
    );
    expect(expired).toEqual({ status: "EXPIRED", status_reason: "ADMIN" });

    // The buyer pays anyway: the payment cannot become a sale and is refunded.
    await page.getByTestId("mock-pay").click();
    await expect(page).toHaveURL(/\/he\/orders\/GG-[0-9A-Z]{6}\?k=/);
    for (let i = 0; i < 3; i++) await runCron(request, "outbox");
    const [attempt] = await e2eQuery<{ status: string; refund: string | null }>(
      `SELECT pa.status, r.status AS refund FROM payment_attempts pa
         LEFT JOIN refunds r ON r.attempt_id = pa.id WHERE pa.provider_ref = $1`,
      [ref],
    );
    expect(attempt?.refund).toBe("SUCCEEDED");
    expect(["NEEDS_REFUND", "REFUNDED"]).toContain(attempt?.status);
    const mail = await mailbox.waitFor({
      template: "purchase-not-completed",
      to: buyer.email,
    });
    expect(mail[0]?.locale).toBe("he");
    // Exactly one live sale: the offline one.
    const salesRows = await e2eQuery<{ channel: string }>(
      "SELECT channel FROM sales WHERE artwork_id = $1 AND voided_at IS NULL",
      [a.id],
    );
    expect(salesRows).toEqual([{ channel: "OFFLINE" }]);
    await page.goto(`/he/works/${a.slug}`);
    await expect(page.getByTestId("artwork-status")).toHaveText(
      heArtwork.status.sold,
    );
  } finally {
    await admin.close();
  }
});
