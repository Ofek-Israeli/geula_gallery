import { expect, test } from "@playwright/test";

/**
 * M2 minimal storefront over the seeded demo catalog (spec §8.3, §6.3). WS1 adds the full
 * `storefront` spec (filters, lightbox, JSON-LD).
 */
test.describe("minimal storefront @smoke", () => {
  test("works lists available works first; a sold work stays in its list, labelled Sold", async ({
    page,
  }) => {
    await page.goto("/en/works");
    await expect(
      page.getByRole("heading", { level: 1, name: "Works" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "The Path" }).first(),
    ).toBeVisible();
    // No sold strip, archive or filter (the painter's choice).
    await expect(
      page.getByRole("region", { name: "Recently sold" }),
    ).toHaveCount(0);
    await expect(page.getByRole("option", { name: /sold/i })).toHaveCount(0);
    // The seeded sold "Reflection in the Pool" stays in its series, labelled Sold.
    await page.goto("/en/works?series=landscapes");
    const card = page.getByRole("article").filter({
      has: page.getByRole("link", { name: "Reflection in the Pool" }),
    });
    await expect(card.getByText("Sold", { exact: true })).toBeVisible();
  });

  test("an available work shows price, Buy now and delivery from IL", async ({
    page,
  }) => {
    await page.goto("/en/works/the-path");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "The Path",
    );
    await expect(page.getByTestId("artwork-status")).toHaveText("Available");
    await expect(page.getByText("₪3,200").first()).toBeVisible();
    await expect(page.getByTestId("buy-now")).toHaveAttribute(
      "href",
      "/en/checkout/the-path",
    );
    // Israel Post home delivery (₪73) beats the courier table's ₪120.
    await expect(page.getByText("Delivery in Israel from ₪73")).toBeVisible();
    // No depth was measured, so the dimensions are H × W only.
    await expect(page.getByText(/72 × 52\s*cm/)).toBeVisible();
    await expect(
      page.getByText("Dimensions (H × W)", { exact: true }),
    ).toBeVisible();
    // The painter's own photographs carry no image credit line.
    await expect(page.locator("figcaption")).toHaveCount(0);
  });

  test("sold, reserved-offline and not-for-sale works have no Buy now", async ({
    page,
  }) => {
    for (const [slug, status] of [
      ["plant-near-a-window", "Sold"],
      ["a-ship-in-the-heart-of-the-sea", "Reserved"],
      ["the-piano", "Not for sale"],
    ] as const) {
      await page.goto(`/en/works/${slug}`);
      await expect(page.getByTestId("artwork-status")).toHaveText(status);
      await expect(page.getByTestId("buy-now")).toHaveCount(0);
    }
  });

  test("an old archive link shows the works list; credits render in Hebrew", async ({
    page,
  }) => {
    await page.goto("/he/works?availability=sold");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("יצירות");
    await page.goto("/he/works?series=landscapes");
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("link", { name: "השתקפות בבריכה" }) });
    await expect(card.getByText("נמכרה", { exact: true })).toBeVisible();
    await page.goto("/he/credits");
    await expect(page.getByText(/Frank Ruhl Libre/)).toBeVisible();
  });
});
