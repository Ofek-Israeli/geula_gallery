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
  cloneWork,
  e2eQuery,
  mailbox,
  messages,
  runCron,
} from "./support/commerce";

const SLUG = "e2e-quote-requote";

/**
 * Spec §10.4 `quote` (spec §5.8): a buyer requests a quote → `request-ack` and the painter
 * notification → the admin replies with a template and sends a quote (a link order at a locked
 * price) → the `checkout-link` email → the buyer opens the link.
 *
 * "Send quote" calls `createLinkOrder` (WS2). The second test sends an unlocked quote (table
 * shipping) on an `e2e-` clone; the buyer changes the delivery method on the link-order page
 * (requote) and pays.
 */
const inbox = HE.shell.inbox;
const en = messages("en", "orders");
const ec = messages("en", "checkout");

test.use({ extraHTTPHeaders: buyerIp(42) });

test("quote request → ack + painter email → reply → send quote → link email", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const admin = await adminContext(browser);
  try {
    const ap = await admin.newPage();
    const a = await createPublishedArtwork(ap, { prefix: "Quote work" });

    // The buyer asks for a quote (works without JS too: a plain form POST).
    const buyer = uniqueBuyer("quote");
    await page.goto(`/en/works/${a.slug}/request?kind=quote`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Request a quote",
    );
    const form = page.getByTestId("request-form");
    await form.getByLabel(/^Full name/).fill(buyer.name);
    await form.getByLabel(/^Email/).fill(buyer.email);
    await form.getByLabel(/^Shipping country/).selectOption("US");
    await form.getByLabel(/^Message/).fill("Shipping to Boston, please.");
    await form.getByTestId("request-submit").click();
    await expect(page.getByTestId("request-thanks")).toContainText(buyer.email);

    for (let i = 0; i < 2; i++) await runCron(request, "outbox");
    const ack = await mailbox.waitFor({
      template: "request-ack",
      to: buyer.email,
    });
    expect(ack[0]?.locale).toBe("en");
    expect(ack[0]?.subject).toContain(a.titleEn);
    const [row] = await e2eQuery<{ id: string; status: string }>(
      "SELECT id, status FROM buyer_requests WHERE lower(email) = $1",
      [buyer.email.toLowerCase()],
    );
    expect(row?.status).toBe("NEW");
    const painter = await mailbox.waitFor({ template: "painter-new-request" });
    expect(
      painter.some((m) =>
        (m.html ?? "").includes(`/he/admin/inbox/${row?.id}`),
      ),
    ).toBe(true);

    // The admin sees it in the inbox and replies with a template (emailed in English).
    await ap.goto("/he/admin/inbox");
    await ap.getByRole("link", { name: buyer.name }).click();
    await expect(ap.getByTestId("request-message")).toContainText("Boston");
    const reply = ap.getByTestId("reply-form");
    await expect(async () => {
      await reply.getByLabel(inbox.replyTemplate).selectOption("quoteSoon");
      await expect(field(reply, inbox.reply)).toHaveValue(/Hello/, {
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await reply.getByRole("button", { name: inbox.send }).click();
    await expect(reply.getByTestId("form-success")).toHaveText(inbox.sent);
    for (let i = 0; i < 2; i++) await runCron(request, "outbox");
    const replyMail = await mailbox.waitFor({
      template: "request-reply",
      to: buyer.email,
    });
    expect(replyMail[0]?.text).toContain("checking the shipping cost");

    // Send the quote: USD price and a fixed shipping price.
    const quote = ap.getByTestId("send-quote-form");
    await field(quote, inbox.currency).selectOption("USD");
    await field(quote, inbox.itemPrice).fill("650");
    await field(quote, inbox.lockedShipping).fill("120");
    await submitWithConfirm(quote, inbox.quoteSubmit, inbox.quoteSubmit);
    // On success the quote section unmounts (the request is no longer NEW): wait for the new
    // status, or an error inside the still-mounted form.
    const status = ap.getByTestId("request-status");
    await expect(
      quote
        .getByTestId("form-error")
        .or(status.filter({ hasText: inbox.status.QUOTED })),
    ).toBeVisible();
    await expect(status).toHaveText(inbox.status.QUOTED);
    const [quoted] = await e2eQuery<{
      status: string;
      order_id: string | null;
    }>("SELECT status, order_id FROM buyer_requests WHERE id = $1", [row?.id]);
    expect(quoted?.status).toBe("QUOTED");
    expect(quoted?.order_id).toBeTruthy();
    for (let i = 0; i < 2; i++) await runCron(request, "outbox");
    const link = await mailbox.waitFor({
      template: "checkout-link",
      to: buyer.email,
    });
    const payUrl = /href="(http[^"]+\/orders\/GG-[^"]+)"/.exec(
      link[0]?.html ?? "",
    )?.[1];
    expect(payUrl).toBeTruthy();
    await page.goto(payUrl ?? "");
    await expect(page.getByTestId("order-number")).toBeVisible();
  } finally {
    await admin.close();
  }
});

test("quote link: requote by a method change, then pay", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await cloneWork("still-life-no-15", SLUG);
  const buyer = uniqueBuyer("requote");
  await page.goto(`/en/works/${SLUG}/request?kind=quote`);
  const form = page.getByTestId("request-form");
  await form.getByLabel(/^Full name/).fill(buyer.name);
  await form.getByLabel(/^Email/).fill(buyer.email);
  await form.getByLabel(/^Shipping country/).selectOption("IL");
  await form.getByLabel(/^Message/).fill("Courier to Haifa, please.");
  await form.getByTestId("request-submit").click();
  await expect(page.getByTestId("request-thanks")).toBeVisible();
  const [row] = await e2eQuery<{ id: string }>(
    "SELECT id FROM buyer_requests WHERE lower(email) = $1",
    [buyer.email.toLowerCase()],
  );

  const admin = await adminContext(browser);
  try {
    // An unlocked quote at the list price: table shipping (courier), the buyer may change it.
    const ap = await admin.newPage();
    await ap.goto(`/he/admin/inbox/${row?.id}`);
    const quote = ap.getByTestId("send-quote-form");
    await field(quote, inbox.shippingMethod).selectOption("CARRIER_TABLE");
    await submitWithConfirm(quote, inbox.quoteSubmit, inbox.quoteSubmit);
    const status = ap.getByTestId("request-status");
    await expect(
      quote
        .getByTestId("form-error")
        .or(status.filter({ hasText: inbox.status.QUOTED })),
    ).toBeVisible();
    await expect(status).toHaveText(inbox.status.QUOTED);
  } finally {
    await admin.close();
  }
  const [before] = await e2eQuery<{
    id: string;
    shipping_method: string;
    shipping_locked: boolean;
    shipping_minor: number;
    quote_version: number;
  }>(
    `SELECT o.id, o.shipping_method, o.shipping_locked, o.shipping_minor, o.quote_version
       FROM orders o JOIN buyer_requests r ON r.order_id = o.id WHERE r.id = $1`,
    [row?.id],
  );
  expect(before).toMatchObject({
    shipping_method: "CARRIER_TABLE",
    shipping_locked: false,
  });
  expect(before?.shipping_minor).toBeGreaterThan(0);

  for (let i = 0; i < 2; i++) await runCron(request, "outbox");
  const link = await mailbox.waitFor({
    template: "checkout-link",
    to: buyer.email,
  });
  const payUrl = /href="(http[^"]+\/orders\/GG-[^"]+)"/.exec(
    link[0]?.html ?? "",
  )?.[1];
  expect(payUrl).toBeTruthy();
  await page.goto((payUrl ?? "").replaceAll("&amp;", "&"));

  // The buyer switches to studio pickup: the order is requoted (no shipping) before paying.
  const details = page.getByTestId("link-details-form");
  await details
    .getByRole("radio", { name: new RegExp(`^${en.link.method.LOCAL_PICKUP}`) })
    .check();
  await details
    .getByLabel(new RegExp(`^${en.link.recipient}`))
    .fill(buyer.name);
  await details
    .getByLabel(new RegExp(`^${ec.details.line1}`))
    .fill("1 Example Street");
  await details.getByLabel(new RegExp(`^${ec.details.city}`)).fill("Haifa");
  await details.getByLabel(ec.consent.terms).check();
  await details.getByLabel(ec.consent.age).check();
  await details.getByTestId("link-details-submit").click();
  await expect(page.getByTestId("link-details-result")).toHaveText(
    en.link.requoted,
  );
  const [after] = await e2eQuery<{
    shipping_method: string;
    shipping_minor: number;
    quote_version: number;
  }>(
    "SELECT shipping_method, shipping_minor, quote_version FROM orders WHERE id = $1",
    [before?.id],
  );
  expect(after).toMatchObject({
    shipping_method: "LOCAL_PICKUP",
    shipping_minor: 0,
  });
  expect(after?.quote_version).toBeGreaterThan(before?.quote_version ?? 0);

  await page.getByTestId("pay-now").click();
  await expect(page).toHaveURL(/\/en\/mock-pay\/mock_[0-9a-f]{32}/);
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);
  await expect(page.getByTestId("order-status")).toHaveText(en.status.PAID);
  const [paid] = await e2eQuery<{ status: string }>(
    "SELECT status FROM buyer_requests WHERE id = $1",
    [row?.id],
  );
  expect(paid?.status).toBe("CONVERTED");
});
