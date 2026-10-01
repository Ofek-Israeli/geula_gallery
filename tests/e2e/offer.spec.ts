import { expect, type Page, test } from "@playwright/test";
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
 * Spec §10.4 `offer` (Tier B, spec §5.8): an offer below the painter's threshold is auto-declined
 * with an emailed reply; an acceptable offer reaches the inbox and the admin accepts it → a link
 * order at the offered price (WS2 `createLinkOrder`; the spec skips from there until M4).
 */
const c = HE.catalog;
const inbox = HE.shell.inbox;

test.use({ extraHTTPHeaders: buyerIp(43) });

async function makeOffer(
  page: Page,
  slug: string,
  email: string,
  amount: string,
) {
  await page.goto(`/en/works/${slug}/request?kind=offer`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Make an offer",
  );
  const form = page.getByTestId("request-form");
  await form.getByLabel(/^Full name/).fill("Olive Offer");
  await form.getByLabel(/^Email/).fill(email);
  await form.getByLabel(/^Shipping country/).selectOption("US");
  await form.getByLabel(/^Offer amount/).fill(amount);
  await form.getByLabel(/^Currency/).selectOption("USD");
  await form.getByTestId("request-submit").click();
  await expect(page.getByTestId("request-thanks")).toBeVisible();
}

test("auto-decline below the threshold; accept an offer → link order", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const admin = await adminContext(browser);
  try {
    const ap = await admin.newPage();
    const a = await createPublishedArtwork(ap, {
      prefix: "Offer work",
      ils: "3000",
      usd: "800",
    });
    const price = ap.getByTestId("price-form");
    await price.getByLabel(c.fields.offersEnabled).check();
    await field(price, c.fields.offerAutoDeclineBelowIls).fill("2000");
    await price.getByRole("button", { name: HE.shell.common.save }).click();
    // The form already shows "saved" from the first price save: wait for the row instead.
    await expect
      .poll(async () => {
        const [row] = await e2eQuery<{ offers_enabled: boolean }>(
          "SELECT offers_enabled FROM artworks WHERE id = $1",
          [a.id],
        );
        return row?.offers_enabled;
      })
      .toBe(true);

    // USD 100 is far below ₪2,000: auto-declined, the buyer gets a reply, the painter nothing.
    const low = uniqueBuyer("offer-low");
    await makeOffer(page, a.slug, low.email, "100");
    for (let i = 0; i < 2; i++) await runCron(request, "outbox");
    const [declined] = await e2eQuery<{ status: string }>(
      "SELECT status FROM buyer_requests WHERE lower(email) = $1",
      [low.email.toLowerCase()],
    );
    expect(declined?.status).toBe("AUTO_DECLINED");
    const reply = await mailbox.waitFor({
      template: "request-reply",
      to: low.email,
    });
    expect(reply[0]?.text).toContain(a.titleEn);

    // USD 700 is acceptable: it reaches the inbox.
    const buyer = uniqueBuyer("offer");
    await makeOffer(page, a.slug, buyer.email, "700");
    for (let i = 0; i < 2; i++) await runCron(request, "outbox");
    await mailbox.waitFor({ template: "request-ack", to: buyer.email });
    await ap.goto("/he/admin/inbox?filter=offers");
    await ap
      .getByTestId("inbox-row")
      .filter({ hasText: a.titleHe })
      .getByRole("link")
      .first()
      .click();
    await expect(ap.getByTestId("answer-offer")).toContainText("700");
    const accept = ap.getByTestId("accept-offer-form");
    await field(accept, inbox.lockedShipping).fill("90");
    await submitWithConfirm(accept, inbox.accept, inbox.accept);
    await expect(
      accept.getByTestId("form-success").or(accept.getByTestId("form-error")),
    ).toBeVisible();
    if (
      (await accept.getByTestId("form-error").getAttribute("data-code")) ===
      "NOT_IMPLEMENTED"
    ) {
      test.skip(
        true,
        "createLinkOrder (WS2) is not integrated in this worktree yet",
      );
    }
    await expect(accept.getByTestId("form-success")).toBeVisible();
    const [row] = await e2eQuery<{ status: string; order_id: string | null }>(
      "SELECT status, order_id FROM buyer_requests WHERE lower(email) = $1",
      [buyer.email.toLowerCase()],
    );
    expect(row?.status).toBe("ACCEPTED");
    const [order] = await e2eQuery<{
      items_total_minor: number;
      currency: string;
      source: string;
    }>("SELECT items_total_minor, currency, source FROM orders WHERE id = $1", [
      row?.order_id,
    ]);
    expect(order).toEqual({
      items_total_minor: 70_000,
      currency: "USD",
      source: "OFFER",
    });
  } finally {
    await admin.close();
  }
});

test.fixme("accepted offer: pay through the emailed link (WS2 link-order page)", () => {});
