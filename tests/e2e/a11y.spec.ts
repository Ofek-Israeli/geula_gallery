import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { withGalleryImages } from "../helpers/factories/storefront";

/**
 * axe on the public storefront pages (spec §6.7, §10.4 `a11y`; WS1 part): home, works (default,
 * filtered, archive), artwork (available, sold, with the lightbox open), about, contact and
 * credits, in Hebrew and English. Zero serious or critical violations. Checkout, cancel, order
 * and admin pages are covered by their owners' specs.
 */
const PAGES = [
  "/",
  "/works",
  "/works?size=m&sort=price-asc",
  "/works?availability=sold",
  "/works/landscape-no-26",
  "/works/moonrise",
  "/works/boats-at-rest",
  "/about",
  "/contact",
  "/credits",
] as const;

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
}

test.beforeAll(async () => {
  await withGalleryImages("landscape-no-26", 3);
});

for (const locale of ["he", "en"] as const) {
  for (const path of PAGES) {
    test(`axe: /${locale}${path === "/" ? "" : path}`, async ({ page }) => {
      const res = await page.goto(`/${locale}${path === "/" ? "" : path}`, {
        waitUntil: "load",
      });
      expect(res?.status()).toBe(200);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test(`axe: lightbox open (${locale})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${locale}/works/landscape-no-26`, {
      waitUntil: "load",
    });
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await page.getByTestId("gallery-open").click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass();
    // Check contrast only once the fade-in has finished.
    await expect
      .poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
    expect(await seriousViolations(page)).toEqual([]);
  });
}
