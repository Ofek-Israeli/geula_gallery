import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  adminContext,
  createPublishedArtwork,
  field,
  HE,
  submitWithConfirm,
} from "./support/admin";
import { buyerIp, e2eQuery, mailbox, runCron } from "./support/commerce";

/**
 * Spec §10.4 `quote` (spec §5.8): a buyer requests a quote → `request-ack` and the painter
 * notification → the admin replies with a template and sends a quote (a link order at a locked
 * price) → the `checkout-link` email → the buyer opens the link.
 *
 * "Send quote" calls `createLinkOrder` (WS2). Until WS2 lands in M4 the admin form answers
 * NOT_IMPLEMENTED and the spec skips from that point; the requote-by-method-change and payment
 * steps on the link-order page are WS2's UI (see the `fixme` below).
 */
const r = HE.requests;
const inbox = HE.shell.inbox;

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
    const outcome = quote
      .getByTestId("form-success")
      .or(quote.getByTestId("form-error"));
    await expect(outcome).toBeVisible();
    if (
      (await quote.getByTestId("form-error").getAttribute("data-code")) ===
      "NOT_IMPLEMENTED"
    ) {
      test.skip(
        true,
        "createLinkOrder (WS2) is not integrated in this worktree yet",
      );
    }
    await expect(quote.getByTestId("form-success")).toHaveText(inbox.quoteSent);
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

test.fixme("quote link: requote by a method change, then pay (WS2 link-order page)", () => {});
