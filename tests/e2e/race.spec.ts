import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import { buyerIp, fillCheckout, messages } from "./support/commerce";

/**
 * Spec §10.4 `race` (M2 acceptance): two buyers in two browser contexts press "Continue to
 * payment" for the same work at the same moment. Exactly one reaches the mock payment page; the
 * other sees "just reserved". The winner pays and the work is Sold for everyone.
 */
const enCheckout = messages("en", "checkout");
const enOrders = messages("en", "orders");
const enArtwork = messages("en", "artwork");

test("two buyers, one work: one pays, the other sees 'just reserved'", async ({
  browser,
}) => {
  const slug = "at-the-rivers-bend";
  const contexts = await Promise.all(
    [21, 22].map((n) =>
      browser.newContext({ extraHTTPHeaders: buyerIp(n), locale: "en-US" }),
    ),
  );
  try {
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    await Promise.all(
      pages.map(async (page, i) => {
        await page.goto(`/en/checkout/${slug}?ship=LOCAL_PICKUP`);
        await fillCheckout(page, {
          locale: "en",
          ...uniqueBuyer(`race-${i}`),
        });
      }),
    );

    // Both submit together.
    await Promise.all(
      pages.map((p) => p.getByTestId("checkout-submit").click()),
    );
    const outcomes = await Promise.all(
      pages.map(async (page) => {
        const reached = page
          .waitForURL(/\/en\/mock-pay\/mock_[0-9a-f]{32}/, { timeout: 20_000 })
          .then(() => "pay" as const);
        const refused = page
          .getByText(enCheckout.errors.just_reserved)
          .waitFor({ timeout: 20_000 })
          .then(() => "refused" as const);
        return Promise.any([reached, refused]);
      }),
    );
    expect([...outcomes].sort()).toEqual(["pay", "refused"]);

    const winner = pages[outcomes.indexOf("pay")];
    const loser = pages[outcomes.indexOf("refused")];
    if (!winner || !loser) throw new Error("unreachable");
    // The loser is still on the checkout page with nothing reserved for them.
    await expect(loser).toHaveURL(new RegExp(`/en/checkout/${slug}`));

    await winner.getByTestId("mock-pay").click();
    await expect(winner.getByTestId("order-status")).toHaveText(
      enOrders.status.PAID,
    );

    await loser.goto(`/en/works/${slug}`);
    await expect(loser.getByTestId("artwork-status")).toHaveText(
      enArtwork.status.sold,
    );
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
