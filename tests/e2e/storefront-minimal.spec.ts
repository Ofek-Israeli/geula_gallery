import { expect, test } from "@playwright/test";

/**
 * M2 minimal storefront over the seeded demo catalog (spec §8.3, §6.3). WS1 adds the full
 * `storefront` spec (filters, lightbox, JSON-LD).
 */
test.describe("minimal storefront @smoke", () => {
  test("works lists available works first, with the recently sold strip", async ({
    page,
  }) => {
    await page.goto("/en/works");
    await expect(
      page.getByRole("heading", { level: 1, name: "Works" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Landscape no. 26" }).first(),
    ).toBeVisible();
    const sold = page.getByRole("region", { name: "Recently sold" });
    await expect(sold.getByRole("link", { name: "Moonrise" })).toBeVisible();
    await expect(sold.getByText("Sold").first()).toBeVisible();
  });

  test("an available work shows price, Buy now and delivery from IL", async ({
    page,
  }) => {
    await page.goto("/en/works/landscape-no-26");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Landscape no. 26",
    );
    await expect(page.getByTestId("artwork-status")).toHaveText("Available");
    await expect(page.getByText("₪3,200").first()).toBeVisible();
    await expect(page.getByTestId("buy-now")).toHaveAttribute(
      "href",
      "/en/checkout/landscape-no-26",
    );
    await expect(page.getByText("Delivery in Israel from ₪60")).toBeVisible();
    await expect(page.getByText(/30\.5 × 30\.5 × 1\s*cm/)).toBeVisible();
    await expect(
      page.getByText(/Art Institute of Chicago/).first(),
    ).toBeVisible();
  });

  test("sold, reserved-offline and not-for-sale works have no Buy now", async ({
    page,
  }) => {
    for (const [slug, status] of [
      ["the-red-room-etretat", "Sold"],
      ["boats-at-rest", "Reserved"],
      ["interior-music-room", "Not for sale"],
    ] as const) {
      await page.goto(`/en/works/${slug}`);
      await expect(page.getByTestId("artwork-status")).toHaveText(status);
      await expect(page.getByTestId("buy-now")).toHaveCount(0);
    }
  });

  test("the sold archive and credits render in Hebrew", async ({ page }) => {
    await page.goto("/he/works?availability=sold");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "ארכיון: יצירות שנמכרו",
    );
    await expect(
      page.getByRole("link", { name: "זריחת הירח" }).first(),
    ).toBeVisible();
    await page.goto("/he/credits");
    await expect(
      page.getByText(/George Inness\. Moonrise, 1891\./),
    ).toBeVisible();
  });
});
