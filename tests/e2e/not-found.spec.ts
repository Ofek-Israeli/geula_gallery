import { expect, test } from "@playwright/test";

/**
 * 404s (spec §6.4, §10.4 `not-found`): an unknown work renders the localized not-found page
 * (client-rendered from the RSC payload in Next 16.3.8, so the text is awaited after hydration;
 * see docs/architecture.md), and unmatched URLs render the bilingual global 404.
 */
test.describe("not found", () => {
  for (const [locale, title, home] of [
    ["he", "הדף לא נמצא", "חזרה לדף הבית"],
    ["en", "Page not found", "Back to the home page"],
  ] as const) {
    test(`an unknown work is a localized 404 (${locale})`, async ({ page }) => {
      const res = await page.goto(`/${locale}/works/no-such-work`);
      expect(res?.status()).toBe(404);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(
        page.getByRole("heading", { level: 1, name: title }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: home })).toHaveAttribute(
        "href",
        `/${locale}`,
      );
    });
  }

  test("an unpublished-looking slug with bad characters is a 404", async ({
    request,
  }) => {
    const res = await request.get("/en/works/Not_A_Slug");
    expect(res.status()).toBe(404);
  });

  test("unmatched URLs render the bilingual global 404", async ({ page }) => {
    const res = await page.goto("/en/no/such/page");
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "הדף לא נמצא" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await expect(page.locator('section[lang="en"]')).toHaveAttribute(
      "dir",
      "ltr",
    );
  });

  test("an unknown locale is a 404", async ({ request }) => {
    const res = await request.get("/fr/works");
    expect(res.status()).toBe(404);
  });

  test("404 pages are not indexed", async ({ request }) => {
    const res = await request.get("/he/works/no-such-work");
    expect(res.status()).toBe(404);
    expect(res.headers()["x-robots-tag"] ?? "").toContain("noindex");
  });
});
