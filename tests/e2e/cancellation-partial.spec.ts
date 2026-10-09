import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import { ADMIN_STORAGE_STATE } from "./e2e-env";
import {
  buyerIp,
  cloneWork,
  continueToMockPay,
  e2eQuery,
  fillCheckout,
  messages,
  runCron,
} from "./support/commerce";

/**
 * Per-work cancellation: a cart of three works paid in one order (courier in Israel); the buyer
 * cancels two of them on `/cancel` (the review step lists the works as checkboxes); the admin sees
 * the two works ticked with the amounts and accepts; the refund settles while the order stays
 * PAID; the two works are relisted and the third stays Sold; the fulfillment page packs the third
 * alone and names the cancelled works. Plus axe on the review step with the checkboxes (he, en).
 * One paid order serves every step, and the cloned works are unpublished at the end, so the
 * storefront's sold archive is not crowded for the other specs.
 */
const en = messages("en", "cancel");
const WORKS = [
  { slug: "e2e-partial-1", title: "Partial One" },
  { slug: "e2e-partial-2", title: "Partial Two" },
  { slug: "e2e-partial-3", title: "Partial Three" },
] as const;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("condition not met");
}

async function buyCart(page: Page, prefix: string): Promise<string> {
  for (const w of WORKS) {
    const slug = `${w.slug}-${prefix}`;
    await cloneWork("puzzle", slug);
    await e2eQuery(
      "UPDATE artworks SET title_en = $2, title_he = $2 WHERE slug = $1",
      [slug, `${w.title} ${prefix}`],
    );
    await page.goto(`/en/works/${slug}`);
    await page.getByTestId("add-to-cart").click();
    await expect(page).toHaveURL(/cart=added/);
  }
  await page.goto("/en/checkout?to=IL&ship=CARRIER_TABLE");
  await expect(page.getByTestId("summary-line")).toHaveCount(3);
  const buyer = uniqueBuyer(`partial-${prefix}`);
  await fillCheckout(page, {
    locale: "en",
    name: buyer.name,
    email: buyer.email,
    address: true,
  });
  await continueToMockPay(page);
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);
  return (await page.getByTestId("order-number").textContent()) ?? "";
}

async function reviewNotice(
  page: Page,
  locale: "he" | "en",
  orderNumber: string,
  name: string,
) {
  const m = messages(locale, "cancel");
  await page.goto(`/${locale}/cancel`);
  const form = page.getByTestId("cancel-form");
  const box = (label: string) =>
    form.getByRole("textbox", { name: new RegExp(`^${escapeRe(label)}`) });
  await box(m.form.fullName).fill(name);
  await box(m.form.orderNumber).fill(orderNumber);
  await form.getByLabel(m.form.reason).selectOption("CHANGE_OF_MIND");
  await form.getByRole("button", { name: m.form.submit }).click();
  await expect(page.getByTestId("cancel-review")).toBeVisible();
  await expect(page.getByTestId("cancel-works")).toBeVisible();
  const r = await new AxeBuilder({ page }).analyze();
  expect(
    r.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
    `axe ${locale}`,
  ).toEqual([]);
}

test("cancel two of three works: admin accepts, refund, relist those two, ship the third", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  await page.context().setExtraHTTPHeaders(buyerIp(82));
  const orderNumber = await buyCart(page, "a");
  const [order] = await e2eQuery<{ id: string; buyer_name: string }>(
    "SELECT id, buyer_name FROM orders WHERE number = $1",
    [orderNumber],
  );
  expect(order).toBeTruthy();
  try {
    await cancelTwoOfThree(page, browser, request, orderNumber, order);
  } finally {
    await e2eQuery(
      "UPDATE artworks SET published_at = NULL WHERE slug LIKE 'e2e-partial-%'",
    );
  }
});

async function cancelTwoOfThree(
  page: Page,
  browser: import("@playwright/test").Browser,
  request: import("@playwright/test").APIRequestContext,
  orderNumber: string,
  order: { id: string; buyer_name: string } | undefined,
) {
  // Reviewed in Hebrew first (nothing is stored before "confirm"), then in English.
  await reviewNotice(page, "he", orderNumber, order?.buyer_name ?? "");
  // The buyer keeps the third work.
  await reviewNotice(page, "en", orderNumber, order?.buyer_name ?? "");
  const works = page.getByTestId("cancel-works");
  await expect(works.getByRole("checkbox")).toHaveCount(3);
  for (const box of await works.getByRole("checkbox").all()) {
    await expect(box).toBeChecked();
  }
  await works.getByLabel("Partial Three a").uncheck();
  await page
    .getByTestId("cancel-review")
    .getByRole("button", { name: en.review.confirm })
    .click();
  const ack = page.getByTestId("cancel-ack");
  await expect(ack).toBeVisible();
  await expect(ack).toContainText("Partial One a");
  await expect(ack).not.toContainText("Partial Three a");
  const number = (await page.getByTestId("cancel-number").textContent()) ?? "";

  const admin = await browser.newContext({ storageState: ADMIN_STORAGE_STATE });
  try {
    const ap = await admin.newPage();
    await ap.goto("/en/admin/cancellations");
    await expect(ap.getByTestId("partial-badge").first()).toBeVisible();
    await ap.getByRole("link", { name: number }).click();
    await expect(ap.getByTestId("cancellation-detail")).toBeVisible();
    const accept = ap.getByTestId("accept-cancellation");
    const items = accept.getByTestId("accept-items");
    await expect(items.getByRole("checkbox")).toHaveCount(3);
    await expect(items.getByLabel(/Partial Three a/)).not.toBeChecked();
    await expect(items.getByLabel(/Partial One a/)).toBeChecked();
    // Shipping stays with the third work.
    await expect(accept.getByTestId("preview-shipping")).toHaveText(
      en.admin.previewShippingKept,
    );
    // Ticking the third too would refund the shipping: the preview follows.
    await items.getByLabel(/Partial Three a/).check();
    await expect(accept.getByTestId("preview-shipping")).not.toHaveText(
      en.admin.previewShippingKept,
    );
    await items.getByLabel(/Partial Three a/).uncheck();
    await accept.getByRole("button", { name: en.admin.accept }).click();
    await expect(ap.getByTestId("cancellation-status")).toHaveText(
      en.status.ACCEPTED,
    );

    // The refund settles; the order stays PAID with one work active.
    const settled = await waitFor(async () => {
      await runCron(request, "outbox");
      const rows = await e2eQuery<{ refund: string; order: string }>(
        `SELECT r.status AS refund, o.status AS order
           FROM cancellations c JOIN refunds r ON r.id = c.refund_id
           JOIN orders o ON o.id = c.order_id WHERE c.number = $1`,
        [number],
      );
      return rows[0]?.refund === "SUCCEEDED" ? rows[0] : null;
    });
    expect(settled.order).toBe("PAID");

    await ap.reload();
    await ap
      .getByTestId("relist")
      .getByRole("button", { name: en.admin.relist })
      .click();
    await expect(ap.getByTestId("relist")).toHaveCount(0);
    const statuses = await e2eQuery<{ slug: string; sale_status: string }>(
      "SELECT slug, sale_status FROM artworks WHERE slug = ANY($1) ORDER BY slug",
      [WORKS.map((w) => `${w.slug}-a`)],
    );
    expect(statuses.map((s) => s.sale_status)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "SOLD",
    ]);

    // The fulfillment page packs the third work alone.
    await ap.goto(`/en/admin/orders/${order?.id}/fulfill`);
    await expect(ap.getByTestId("fulfill-removed")).toContainText(
      "Partial One a",
    );
    await expect(ap.getByTestId("pack-form")).toBeVisible();
  } finally {
    await admin.close();
  }
}
