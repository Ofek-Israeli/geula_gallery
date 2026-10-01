import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";

/**
 * M2 part 2: the checkout page, the mock hosted page and the order page over the seeded demo
 * catalog. The full `purchase-il`, `webhook`, `order-retry` and `race` specs build on this.
 * Desktop only (not `@smoke`): a purchase changes the shared E2E database.
 */
test.describe("checkout and order page", () => {
  for (const locale of ["he", "en"] as const) {
    test(`checkout page (${locale}) shows the summary, disclosure and cancellation link`, async ({
      page,
    }) => {
      const res = await page.goto(`/${locale}/checkout/landscape-no-26`);
      expect(res?.status()).toBe(200);
      await expect(page.getByTestId("checkout-summary")).toBeVisible();
      await expect(page.getByTestId("precontract")).toContainText(
        locale === "he" ? "ישראל" : "Israel",
      );
      const cancel = page
        .getByRole("link", {
          name: locale === "he" ? "ביטול עסקה" : "Cancel a purchase",
        })
        .first();
      await expect(cancel).toHaveAttribute("href", `/${locale}/cancel`);
    });
  }

  test("an unknown work 404s and a sold work is blocked", async ({ page }) => {
    const missing = await page.goto("/en/checkout/no-such-work");
    expect(missing?.status()).toBe(404);
    await page.goto("/en/checkout/moonrise");
    await expect(page.getByTestId("checkout-blocked")).toBeVisible();
  });

  test("buy with studio pickup: mock payment → order page Paid", async ({
    page,
  }) => {
    const buyer = uniqueBuyer("checkout");
    await page.goto("/en/checkout/icebound?ship=LOCAL_PICKUP");
    await page.getByRole("textbox", { name: /^Full name/ }).fill(buyer.name);
    await page.getByRole("textbox", { name: /^Email/ }).fill(buyer.email);
    await page.getByRole("textbox", { name: /^Phone/ }).fill("+97230000000");
    await page.getByLabel("I have read and accept").check();
    await page.getByLabel("I am 18 or older.").check();
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/en\/mock-pay\//);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "MOCK PAYMENT – no real money",
    );
    await page.getByTestId("mock-pay").click();
    await expect(page).toHaveURL(
      /\/en\/orders\/GG-[0-9A-Z]{6}\?k=.*payment=paid/,
    );
    await expect(page.getByTestId("order-status")).toHaveText("Paid");
    const number = await page.getByTestId("order-number").textContent();
    await expect(
      page.getByRole("link", { name: /cancellation form/ }),
    ).toHaveAttribute("href", `/en/cancel?order=${number}`);

    await page.goto("/en/works/icebound");
    await expect(page.getByTestId("artwork-status")).toHaveText("Sold");
  });

  test("required consents are enforced on the server", async ({ page }) => {
    await page.goto("/en/checkout/antibes?ship=LOCAL_PICKUP");
    await page.getByRole("textbox", { name: /^Full name/ }).fill("Test Buyer");
    await page
      .getByRole("textbox", { name: /^Email/ })
      .fill("consents@example.test");
    await page.getByRole("textbox", { name: /^Phone/ }).fill("+97230000000");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByRole("alert").first()).toContainText(
      "Please tick this box",
    );
    await expect(page).toHaveURL(/\/en\/checkout\/antibes/);
  });
});
