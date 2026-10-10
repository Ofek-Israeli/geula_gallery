import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  anotherBuyerBuys,
  artworkStatus,
  buyerIp,
  checkoutUrl,
  chooseDelivery,
  chooseDestination,
  cloneWork,
  continueToMockPay,
  fillCheckout,
  messages,
  seriousAxeViolations,
} from "./support/commerce";

/**
 * The cart: add several works from their pages (header count), remove and re-add on the cart page,
 * one checkout for all of them (one delivery choice, one payment; pickup through the steps, with
 * no street address), both works Sold, the cart emptied; a work bought by someone else meanwhile
 * is named and left out; a work that cannot ship to the destination is removed from the checkout,
 * which comes back to the same step; "Buy now" takes a work out of the cart; two buyers with
 * overlapping carts; the cart works without JavaScript; axe on the cart and every checkout step.
 * Each test clones its own works (the E2E database is reset once per run).
 */
const enArtwork = messages("en", "artwork");
const enCheckout = messages("en", "checkout");
const heCheckout = messages("he", "checkout");

async function addToCart(
  page: import("@playwright/test").Page,
  slug: string,
  locale: "he" | "en" = "en",
) {
  await page.goto(`/${locale}/works/${slug}`);
  await page.getByTestId("add-to-cart").click();
  await expect(page).toHaveURL(/cart=added/);
  await expect(page.getByTestId("in-cart")).toBeVisible();
}

test.describe("cart", () => {
  test("two works, one checkout: pickup, mock pay, both Sold, cart emptied", async ({
    page,
  }) => {
    await page.context().setExtraHTTPHeaders(buyerIp(71));
    await cloneWork("puzzle", "e2e-cart-a1");
    await cloneWork("puzzle", "e2e-cart-a2");

    await addToCart(page, "e2e-cart-a1");
    await expect(page.getByTestId("cart-notice")).toHaveText(
      enArtwork.buy.cartNotice.added,
    );
    await expect(page.getByTestId("header-cart")).toContainText("(1)");
    await addToCart(page, "e2e-cart-a2");
    await expect(page.getByTestId("header-cart")).toContainText("(2)");

    // Remove one on the cart page, then add it back.
    await page.goto("/en/cart");
    await expect(page.getByTestId("cart-line")).toHaveCount(2);
    await page.getByTestId("cart-remove").first().click();
    await expect(page).toHaveURL(/cart=removed/);
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await addToCart(page, "e2e-cart-a1");
    await page.goto("/en/cart");
    await expect(page.getByTestId("cart-line")).toHaveCount(2);

    // One checkout for both: the destination, studio pickup, no street address, one payment.
    await page.getByTestId("cart-checkout").click();
    await expect(page).toHaveURL(/\/en\/checkout$/);
    await expect(page.getByTestId("checkout-destination")).toBeVisible();
    await chooseDestination(page, { locale: "en", city: "Haifa" });
    await chooseDelivery(page, { locale: "en", method: "LOCAL_PICKUP" });
    await expect(page.getByTestId("summary-line")).toHaveCount(2);
    await expect(
      page.getByRole("textbox", { name: /^Street and number/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId("checkout-form")).toContainText(
      "the 2 works are reserved for you for 35 minutes",
    );
    const buyer = uniqueBuyer("cart");
    await fillCheckout(page, {
      locale: "en",
      name: buyer.name,
      email: buyer.email,
    });
    await continueToMockPay(page);
    await page.getByTestId("mock-pay").click();
    await expect(page).toHaveURL(
      /\/en\/orders\/GG-[0-9A-Z]{6}\?k=.*payment=paid/,
    );
    await expect(page.getByTestId("order-status")).toHaveText("Paid");
    expect((await artworkStatus("e2e-cart-a1"))?.sale_status).toBe("SOLD");
    expect((await artworkStatus("e2e-cart-a2"))?.sale_status).toBe("SOLD");
    // The ordered works left the cart.
    await expect(page.getByTestId("header-cart")).toHaveCount(0);
  });

  test("courier delivery in Israel, in Hebrew", async ({ page }) => {
    await page.context().setExtraHTTPHeaders(buyerIp(72));
    await cloneWork("puzzle", "e2e-cart-b1");
    await cloneWork("puzzle", "e2e-cart-b2");
    await addToCart(page, "e2e-cart-b1", "he");
    await addToCart(page, "e2e-cart-b2", "he");
    await page.goto(checkoutUrl(null, { locale: "he", ship: "CARRIER_TABLE" }));
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("summary-line")).toHaveCount(2);
    const buyer = uniqueBuyer("cart-he");
    await fillCheckout(page, {
      locale: "he",
      name: buyer.name,
      email: buyer.email,
      address: true,
    });
    await continueToMockPay(page);
    await page.getByTestId("mock-pay").click();
    await expect(page).toHaveURL(/payment=paid/);
    expect((await artworkStatus("e2e-cart-b2"))?.sale_status).toBe("SOLD");
    expect(heCheckout.cart.title).toBeTruthy();
  });

  test("a work bought by another buyer is named on the cart and left out of the checkout", async ({
    page,
  }) => {
    await page.context().setExtraHTTPHeaders(buyerIp(73));
    await cloneWork("puzzle", "e2e-cart-c1");
    await cloneWork("puzzle", "e2e-cart-c2");
    await addToCart(page, "e2e-cart-c1");
    await addToCart(page, "e2e-cart-c2");
    await anotherBuyerBuys(page, "e2e-cart-c2", 74);

    await page.goto("/en/cart");
    await expect(page.getByTestId("cart-line-status")).toHaveText(
      enCheckout.cart.status.sold,
    );
    await page.goto("/en/checkout");
    await expect(page.getByTestId("checkout-excluded")).toBeVisible();
    await expect(page.getByTestId("checkout-works").locator("li")).toHaveCount(
      1,
    );
  });

  test("Buy now on a work in the cart takes it out of the cart", async ({
    page,
  }) => {
    await page.context().setExtraHTTPHeaders(buyerIp(75));
    await cloneWork("puzzle", "e2e-cart-d1");
    await addToCart(page, "e2e-cart-d1");
    await page.goto(checkoutUrl("e2e-cart-d1", { ship: "LOCAL_PICKUP" }));
    const buyer = uniqueBuyer("cart-buynow");
    await fillCheckout(page, {
      locale: "en",
      name: buyer.name,
      email: buyer.email,
    });
    await continueToMockPay(page);
    await page.goto("/en/cart");
    await expect(page.getByTestId("cart-empty")).toBeVisible();
  });

  test("a work that cannot ship abroad is removed from the checkout, which keeps the destination and step", async ({
    page,
  }) => {
    await page.context().setExtraHTTPHeaders(buyerIp(81));
    // `lone-home` is sold for delivery in Israel only; its clone keeps that flag.
    await cloneWork("lone-home", "e2e-cart-g1");
    await cloneWork("puzzle", "e2e-cart-g2");
    await addToCart(page, "e2e-cart-g1");
    await addToCart(page, "e2e-cart-g2");
    await page.goto("/en/checkout");
    await chooseDestination(page, {
      locale: "en",
      to: "US",
      city: "Springfield",
      zip: "62701",
    });
    const problems = page.getByTestId("checkout-problems");
    await expect(problems).toContainText(
      enCheckout.cart.problem.NOT_INTERNATIONAL,
    );
    await problems.getByRole("button").click();
    await expect(page).toHaveURL(
      /\/en\/checkout\?to=US&city=Springfield&zip=62701&step=delivery$/,
    );
    await expect(page.getByTestId("checkout-delivery")).toBeVisible();
    await expect(page.getByTestId("checkout-works").locator("li")).toHaveCount(
      1,
    );
  });

  test("two buyers with overlapping carts: one gets both works, the other is told which was taken", async ({
    browser,
    baseURL,
  }) => {
    await cloneWork("puzzle", "e2e-cart-e1");
    await cloneWork("puzzle", "e2e-cart-e2");
    await cloneWork("puzzle", "e2e-cart-e3");
    const ctxA = await browser.newContext({
      extraHTTPHeaders: buyerIp(76),
      baseURL,
    });
    const ctxB = await browser.newContext({
      extraHTTPHeaders: buyerIp(77),
      baseURL,
    });
    try {
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      await addToCart(a, "e2e-cart-e1");
      await addToCart(a, "e2e-cart-e2");
      await addToCart(b, "e2e-cart-e2");
      await addToCart(b, "e2e-cart-e3");
      for (const [p, tag] of [
        [a, "a"],
        [b, "b"],
      ] as const) {
        await p.goto(checkoutUrl(null, { ship: "LOCAL_PICKUP" }));
        const buyer = uniqueBuyer(`cart-race-${tag}`);
        await fillCheckout(p, {
          locale: "en",
          name: buyer.name,
          email: buyer.email,
        });
      }
      await Promise.all([
        a.getByTestId("checkout-submit").click(),
        b.getByTestId("checkout-submit").click(),
      ]);
      await expect(async () => {
        const urls = [a.url(), b.url()];
        expect(urls.filter((u) => /mock-pay/.test(u))).toHaveLength(1);
      }).toPass({ timeout: 15_000 });
      const loser = /mock-pay/.test(a.url()) ? b : a;
      await expect(loser.getByTestId("checkout-error")).toContainText(/Sorry/);
      const free = /mock-pay/.test(a.url()) ? "e2e-cart-e3" : "e2e-cart-e1";
      expect((await artworkStatus(free))?.reserved_by_order_id).toBeNull();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("adding and removing works without JavaScript", async ({
    browser,
    baseURL,
  }) => {
    await cloneWork("puzzle", "e2e-cart-f1");
    const ctx = await browser.newContext({
      javaScriptEnabled: false,
      extraHTTPHeaders: buyerIp(78),
      baseURL,
    });
    try {
      const page = await ctx.newPage();
      await page.goto("/en/works/e2e-cart-f1");
      await page.getByTestId("add-to-cart").click();
      await expect(page).toHaveURL(/cart=added/);
      await page.goto("/en/cart");
      await expect(page.getByTestId("cart-line")).toHaveCount(1);
      await page.getByTestId("cart-remove").click();
      await expect(page.getByTestId("cart-empty")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  for (const locale of ["he", "en"] as const) {
    test(`axe: the cart and the cart checkout have no serious issues (${locale})`, async ({
      page,
    }) => {
      await page
        .context()
        .setExtraHTTPHeaders(buyerIp(locale === "he" ? 79 : 80));
      await page.goto(`/${locale}/cart`);
      expect(await seriousAxeViolations(page)).toEqual([]);
      const slug = `e2e-cart-axe-${locale}`;
      await cloneWork("puzzle", slug);
      await addToCart(page, slug, locale);
      for (const [path, testId] of [
        [`/${locale}/cart`, "cart-checkout"],
        [`/${locale}/checkout`, "checkout-destination"],
        // Step 1 with errors (no city, no postal code for the US).
        [`/${locale}/checkout?to=US&step=delivery`, "checkout-destination"],
        [checkoutUrl(null, { locale, step: "delivery" }), "checkout-delivery"],
        [checkoutUrl(null, { locale, ship: "LOCAL_PICKUP" }), "checkout-form"],
      ] as const) {
        await page.goto(path);
        await expect(page.getByTestId(testId)).toBeVisible();
        expect(await seriousAxeViolations(page), path).toEqual([]);
      }
    });
  }
});
