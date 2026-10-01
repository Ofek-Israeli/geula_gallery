import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  adminContext,
  createPublishedArtwork,
  field,
  HE,
  submitWithConfirm,
} from "./support/admin";
import { e2eQuery, mailbox, runCron } from "./support/commerce";

/**
 * Spec §10.4 `manual-order` (spec §5.10): the admin creates a manual distance order for a buyer
 * who wrote by phone, records the exact bank transfer → the order is PAID and the buyer receives
 * the order confirmation with the disclosure summary.
 *
 * The order is created by `createLinkOrder(kind MANUAL)` and paid by `recordOfflinePayment`, both
 * WS2 bodies: until M4 integration the admin form answers NOT_IMPLEMENTED and the spec skips.
 */
const o = HE.orders;

test("manual order → record the exact transfer → PAID + disclosure email", async ({
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const admin = await adminContext(browser);
  try {
    const ap = await admin.newPage();
    const a = await createPublishedArtwork(ap, {
      prefix: "Manual order",
      ils: "1800",
    });
    const buyer = uniqueBuyer("manual");

    await ap.goto(`/he/admin/orders/new?artwork=${a.id}`);
    const form = ap.getByTestId("manual-order-form");
    await expect(field(form, o.new.artwork)).toHaveValue(a.id);
    await field(form, o.new.name).fill(buyer.name);
    await field(form, o.new.email).fill(buyer.email);
    await field(form, o.new.phone).fill("+97230000000");
    await field(form, o.new.shippingMethod).selectOption("LOCAL_PICKUP");
    await submitWithConfirm(form, o.new.submit, o.new.submit);

    const error = form.getByTestId("form-error");
    await expect(ap.getByTestId("admin-order").or(error)).toBeVisible();
    if (
      (await error.count()) > 0 &&
      (await error.getAttribute("data-code")) === "NOT_IMPLEMENTED"
    ) {
      test.skip(
        true,
        "createLinkOrder (WS2) is not integrated in this worktree yet",
      );
    }
    await expect(ap.getByTestId("admin-order-status")).toHaveText(
      o.status.AWAITING_PAYMENT,
    );
    const number =
      (await ap.getByTestId("admin-order-number").textContent()) ?? "";

    // A wrong amount is refused; the exact total is recorded.
    const pay = ap.getByTestId("record-payment-form");
    await field(pay, o.payment.amount).fill("1700");
    await field(pay, o.payment.reference).fill("TRF-1001");
    await submitWithConfirm(pay, o.payment.submit, o.payment.submit);
    await expect(pay.getByTestId("form-error")).toHaveAttribute(
      "data-code",
      /AMOUNT_MISMATCH|NOT_IMPLEMENTED/,
    );
    if (
      (await pay.getByTestId("form-error").getAttribute("data-code")) ===
      "NOT_IMPLEMENTED"
    ) {
      test.skip(
        true,
        "recordOfflinePayment (WS2) is not integrated in this worktree yet",
      );
    }
    await field(pay, o.payment.amount).fill("1800");
    await submitWithConfirm(pay, o.payment.submit, o.payment.submit);
    await expect(ap.getByTestId("admin-order-status")).toHaveText(
      o.status.PAID,
    );

    const [order] = await e2eQuery<{
      id: string;
      status: string;
      source: string;
    }>("SELECT id, status, source FROM orders WHERE number = $1", [number]);
    expect(order).toMatchObject({ status: "PAID", source: "MANUAL" });
    const [attempt] = await e2eQuery<{
      provider: string;
      provider_mode: string;
      amount_minor: number;
    }>(
      "SELECT provider, provider_mode, amount_minor FROM payment_attempts WHERE order_id = $1 AND status = 'SUCCEEDED'",
      [order?.id],
    );
    expect(attempt).toEqual({
      provider: "OFFLINE",
      provider_mode: "MANUAL",
      amount_minor: 180_000,
    });
    for (let i = 0; i < 3; i++) await runCron(request, "outbox");
    const confirmation = await mailbox.waitFor({
      template: "order-confirmation",
      to: buyer.email,
    });
    expect(confirmation[0]?.html).toContain("/print/disclosure/");
  } finally {
    await admin.close();
  }
});
