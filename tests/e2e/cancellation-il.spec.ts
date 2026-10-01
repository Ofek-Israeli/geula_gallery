import { expect, type Page, test } from "@playwright/test";
import { validIsraeliId } from "../helpers/factories/compliance";
import { uniqueBuyer } from "../helpers/factories/core";
import { ADMIN_STORAGE_STATE } from "./e2e-env";
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
 * Spec §10.4 `cancellation-il`: the POST form with name + ID; **the URL never contains the ID**;
 * review → confirm → on-screen acknowledgement + email (ID masked) → a resubmission is accepted as
 * a possible duplicate → the admin matches, closes the duplicate, accepts with the suggested fee →
 * refund → credit note → the order is CANCELLED → relist. Plus the cancellation link on the legal
 * pages (the M1 smoke `fixme` for WS6).
 */
const SLUG = "beach-at-cabasson";
const he = messages("he", "cancel");
const heArtwork = messages("he", "artwork");

test.use({ extraHTTPHeaders: buyerIp(61) });

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function submitNotice(
  page: Page,
  idNumber: string,
  fields: { name: string; email?: string; orderNumber?: string },
) {
  await page.goto("/he/cancel");
  const form = page.getByTestId("cancel-form");
  const box = (label: string) =>
    form.getByRole("textbox", { name: new RegExp(`^${escapeRe(label)}`) });
  await box(he.form.fullName).fill(fields.name);
  await box(he.form.idNumber).fill(idNumber);
  if (fields.orderNumber)
    await box(he.form.orderNumber).fill(fields.orderNumber);
  if (fields.email) await box(he.form.email).fill(fields.email);
  await form.getByLabel(he.form.reason).selectOption("CHANGE_OF_MIND");
  await form.getByRole("button", { name: he.form.submit }).click();

  const review = page.getByTestId("cancel-review");
  await expect(review).toBeVisible();
  expect(page.url()).not.toContain(idNumber);
  await expect(review).not.toContainText(idNumber);
  await expect(review).toContainText(idNumber.slice(-2));
  await review.getByRole("button", { name: he.review.confirm }).click();

  const ack = page.getByTestId("cancel-ack");
  await expect(ack).toBeVisible();
  expect(page.url()).not.toContain(idNumber);
  await expect(ack).not.toContainText(idNumber);
  await expect(ack).toContainText(`•••••••${idNumber.slice(-2)}`);
  const number = (await page.getByTestId("cancel-number").textContent()) ?? "";
  expect(number).toMatch(/^C-[0-9A-Z]{6}$/);
  return number;
}

test("IL cancellation: form → ack → duplicate → admin accept → refund → credit note → relist", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const buyer = uniqueBuyer("cancel-il");
  const idNumber = validIsraeliId();

  // A paid order (studio pickup: nothing ships, so accepting refunds at once).
  await page.goto(`/he/checkout/${SLUG}?to=IL&ship=LOCAL_PICKUP`);
  await fillCheckout(page, {
    locale: "he",
    name: buyer.name,
    email: buyer.email,
    receiptByEmail: true,
  });
  await continueToMockPay(page);
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);
  const orderNumber =
    (await page.getByTestId("order-number").textContent()) ?? "";

  // The cancel page lists every channel and posts the form (no query string).
  const res = await page.goto("/he/cancel");
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("cancel-channels")).toContainText(
    "03-000-0000",
  );
  await expect(page.getByTestId("cancel-form")).toHaveAttribute(
    "method",
    /post/i,
  );

  // First notice: name + ID (+ email for the emailed acknowledgement) only.
  const first = await submitNotice(page, idNumber, {
    name: buyer.name,
    email: buyer.email,
  });

  const ackMail = await waitFor(async () => {
    await runCron(request, "outbox");
    return mailbox.latest({
      template: "cancellation-ack",
      to: buyer.email,
      status: "SENT",
    });
  });
  expect(ackMail.subject).toContain(first);
  expect(ackMail.html).not.toContain(idNumber);
  expect(ackMail.text).not.toContain(idNumber);
  expect(ackMail.html).toContain(`•••••••${idNumber.slice(-2)}`);

  // The buyer resubmits (now with the order number): stored, acknowledged, auto-matched.
  const second = await submitNotice(page, idNumber, {
    name: buyer.name,
    email: buyer.email,
    orderNumber,
  });
  expect(second).not.toBe(first);
  const stored = await e2eQuery<{ number: string; order_id: string | null }>(
    "SELECT number, order_id FROM cancellations WHERE number = ANY($1) ORDER BY received_at",
    [[first, second]],
  );
  expect(stored).toHaveLength(2);
  expect(stored[0]?.order_id).toBeNull();
  expect(stored[1]?.order_id).not.toBeNull();
  // No ID in plain text anywhere in the rows the app stores.
  const raw = await e2eQuery<{ row: string }>(
    "SELECT row_to_json(c)::text AS row FROM cancellations c WHERE number = ANY($1)",
    [[first, second]],
  );
  for (const r of raw) expect(r.row).not.toContain(idNumber);

  const admin = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  try {
    const ap = await admin.newPage();
    const open = async (number: string) => {
      await ap.goto("/he/admin/cancellations");
      await ap.getByRole("link", { name: number }).click();
      await expect(ap.getByTestId("cancellation-detail")).toBeVisible();
    };

    // The admin matches the first notice → it is flagged as a possible duplicate.
    await open(first);
    await expect(ap.getByTestId("masked-id")).toHaveText(
      `•••••••${idNumber.slice(-2)}`,
    );
    const match = ap.getByTestId("match-order");
    await match.getByRole("textbox").fill(orderNumber);
    await match.getByRole("button", { name: he.admin.match }).click();
    await expect(ap.getByText(he.admin.duplicateBadge).first()).toBeVisible();

    // …and closes it as a duplicate of the second.
    const dup = ap.getByTestId("close-duplicate");
    await dup.getByRole("textbox").fill(second);
    await dup.getByRole("button", { name: he.admin.closeDuplicate }).click();
    await expect(ap.getByTestId("cancellation-status")).toHaveText(
      he.status.CLOSED,
    );

    // The second notice: refund due 14 days from the notice, the suggested fee, accept.
    await open(second);
    await expect(ap.getByTestId("refund-due")).toBeVisible();
    await expect(ap.getByTestId("suggested-fee")).toContainText("100");
    const accept = ap.getByTestId("accept-cancellation");
    await accept.getByRole("button", { name: he.admin.accept }).click();
    await expect(ap.getByTestId("cancellation-status")).toHaveText(
      he.status.ACCEPTED,
    );

    // The outbox runs the refund, settles it (order CANCELLED) and issues the credit note.
    const settled = await waitFor(async () => {
      await runCron(request, "outbox");
      const rows = await e2eQuery<{
        refund: string;
        order: string;
        note: string | null;
        fee: number;
      }>(
        `SELECT r.status AS refund, o.status AS order, r.fee_withheld_minor AS fee,
                (SELECT t.status FROM tax_documents t WHERE t.refund_id = r.id AND t.kind = 'CREDIT_NOTE') AS note
           FROM cancellations c JOIN refunds r ON r.id = c.refund_id JOIN orders o ON o.id = c.order_id
          WHERE c.number = $1`,
        [second],
      );
      const row = rows[0];
      return row?.refund === "SUCCEEDED" &&
        row.order === "CANCELLED" &&
        row.note === "ISSUED"
        ? row
        : null;
    });
    expect(settled.fee).toBe(10_000); // ₪12,500 × 5% = ₪625 → capped at ₪100

    // Close and relist.
    await ap.reload();
    await ap
      .getByTestId("close-cancellation")
      .getByRole("button", { name: he.admin.close })
      .click();
    await expect(ap.getByTestId("cancellation-status")).toHaveText(
      he.status.CLOSED,
    );
    await ap
      .getByTestId("relist")
      .getByRole("button", { name: he.admin.relist })
      .click();
    await expect(ap.getByTestId("relist-result")).toHaveText(he.admin.done);
  } finally {
    await admin.close();
  }

  await page.goto(`/he/works/${SLUG}`);
  await expect(page.getByTestId("artwork-status")).not.toHaveText(
    heArtwork.status.sold,
  );
});

test("a notice needs the ID/passport or the order number; the form keeps the ID out of the URL", async ({
  page,
}) => {
  await page.goto("/en/cancel");
  const form = page.getByTestId("cancel-form");
  await form.getByRole("textbox", { name: /^Full name/ }).fill("No Identifier");
  await form.getByRole("button", { name: "Continue to review" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "Enter your ID/passport number or your order number",
  );
  expect(page.url()).toMatch(/\/en\/cancel$/);
});

for (const locale of ["he", "en"] as const) {
  test(`legal pages (${locale}) link to /${locale}/cancel`, async ({
    page,
  }) => {
    for (const doc of ["terms", "returns", "privacy"]) {
      const res = await page.goto(`/${locale}/legal/${doc}`);
      expect(res?.status()).toBe(200);
      await expect(
        page
          .getByRole("link", {
            name: locale === "he" ? "ביטול עסקה" : "Cancel a purchase",
          })
          .first(),
      ).toHaveAttribute("href", `/${locale}/cancel`);
    }
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("condition not met");
}
