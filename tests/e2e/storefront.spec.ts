import { expect, type Page, test } from "@playwright/test";
import {
  withDescription,
  withGalleryImages,
} from "../helpers/factories/storefront";
import { messages as appMessages } from "./support/commerce";

/** The `catalog` namespace of the app's messages. */
const messages = (locale: "he" | "en") =>
  appMessages(locale, "catalog") as Record<string, unknown>;

/**
 * WS1 storefront (spec §10.4 `storefront`): URL filters and sorts, Sold as text on sold works in
 * the ordinary lists (no sold strip, archive or filter), JSON-LD availability, the keyboard
 * lightbox (mirrored arrows in Hebrew, Esc, focus return, live region), "insured" only where a
 * quote includes insurance, the home page (the quote over "By the Lake", the bio as its h1), about
 * and contact, and the mobile gallery strip and sticky buy bar.
 *
 * Works used read-only: `the-path` (given 3 images here), `underground-city`, the seeded sold and
 * held works. Purchase specs run in parallel and sell other works, so assertions never depend on
 * the exact set of available works.
 */
const GALLERY_SLUG = "the-path";

test.beforeAll(async () => {
  await withGalleryImages(GALLERY_SLUG, 3);
  // The seeded works have no description yet; give this one enough text below the buy box that
  // the footer stays out of view once the buy box has scrolled away (mobile sticky bar).
  await withDescription(GALLERY_SLUG, 6);
});

async function jsonLd(page: Page): Promise<Record<string, unknown>[]> {
  const blocks = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  return blocks.flatMap((b) => {
    const v = JSON.parse(b) as unknown;
    return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
  });
}

function artworkLd(blocks: Record<string, unknown>[]) {
  const ld = blocks.find(
    (b) => Array.isArray(b["@type"]) && b["@type"].includes("VisualArtwork"),
  );
  expect(ld, "VisualArtwork JSON-LD").toBeDefined();
  return ld as Record<string, unknown> & {
    offers?: Record<string, unknown>;
  };
}

/** Visible card prices on /works, in page order (whole shekels). */
async function cardPrices(page: Page): Promise<number[]> {
  const texts = await page
    .getByRole("list", { name: "Works" })
    .locator("article bdi")
    .filter({ hasText: "₪" })
    .allTextContents();
  return texts.map((t) => Number(t.replace(/[^\d]/g, "")));
}

test.describe("works filters and sorts", () => {
  test("filters and sort are applied from the form and kept in the URL", async ({
    page,
  }) => {
    await page.goto("/en/works");
    const filters = page.getByTestId("works-filters");
    await filters.getByLabel("Price").selectOption("under-5000");
    await filters.getByLabel("Sort by").selectOption("price-desc");
    await filters.getByRole("button", { name: "Show results" }).click();
    await expect(page).toHaveURL(
      /\/en\/works\?price=under-5000&sort=price-desc$/,
    );
    await expect(page.getByTestId("works-count")).toHaveText(/matching work/);
    const grid = page.getByRole("list", { name: "Works" });
    await expect(grid.getByRole("link", { name: "The Path" })).toBeVisible();
    await expect(
      grid.getByRole("link", { name: "Underground City" }),
    ).toBeVisible();
    await expect(grid.getByRole("link", { name: "By the Lake" })).toHaveCount(
      0,
    );
    const prices = await cardPrices(page);
    expect(prices.length).toBeGreaterThan(1);
    expect(prices.every((p) => p < 5000)).toBe(true);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
    // The form shows the active values after the navigation.
    await expect(filters.getByLabel("Price")).toHaveValue("under-5000");

    // The language switch keeps the query (spec §6.4).
    await page.getByRole("link", { name: /Language/ }).click();
    await expect(page).toHaveURL(
      /\/he\/works\?price=under-5000&sort=price-desc$/,
    );
    await expect(
      page.getByTestId("works-filters").getByLabel("מחיר"),
    ).toHaveValue("under-5000");
  });

  test("series, size and orientation filters work from the URL; reset clears them", async ({
    page,
  }) => {
    await page.goto("/en/works?series=interiors-still-life");
    const grid = page.getByRole("list", { name: "Works" });
    await expect(grid.getByRole("link", { name: "The Vase" })).toBeVisible();
    await expect(grid.getByRole("link", { name: "The Path" })).toHaveCount(0);

    await page.goto("/en/works?orientation=panoramic");
    await expect(
      grid.getByRole("link", {
        name: "Reflection in Yellow",
      }),
    ).toBeVisible();
    await expect(page.getByTestId("works-count")).toHaveText("1 matching work");

    await page.goto("/en/works?size=xl&price=under-5000");
    await expect(page.getByText("No works match these filters.")).toBeVisible();
    await page.getByRole("link", { name: "Reset" }).click();
    await expect(page).toHaveURL(/\/en\/works$/);
    await expect(page.getByTestId("works-count")).toHaveText(/^\d+ works$/);
  });

  test("invalid parameters are ignored", async ({ page }) => {
    const res = await page.goto("/en/works?size=huge&sort=random&page=-4");
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("works-count")).toHaveText(/^\d+ works$/);
  });
});

test.describe("sold works in the ordinary lists", () => {
  test("a sold work stays in its series and filters, states Sold as text, and has no Buy now", async ({
    page,
  }) => {
    // The landscapes series lists its sold work after the available ones.
    await page.goto("/en/works?series=landscapes");
    const cards = page.getByRole("article");
    const sold = cards.filter({
      has: page.getByRole("link", { name: "Reflection in the Pool" }),
    });
    // "Sold" in text, not only with the red dot.
    await expect(sold.getByText("Sold", { exact: true })).toBeVisible();
    // A price filter keeps it too.
    await page.goto("/en/works?series=landscapes&price=10000-20000");
    await expect(
      page.getByRole("link", { name: "Reflection in the Pool" }),
    ).toBeVisible();
    // There is no sold filter to choose.
    await expect(
      page.locator('select[name="availability"] option[value="sold"]'),
    ).toHaveCount(0);

    await page.goto("/he/works/reflection-in-the-pool");
    await expect(page.getByTestId("artwork-status")).toHaveText("נמכרה");
    await expect(page.getByTestId("buy-now")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "שאלה על יצירות דומות" }),
    ).toBeVisible();
    // The painter takes no commissions: a sold work offers similar works only.
    await expect(page.getByRole("link", { name: /הזמנת יצירה/ })).toHaveCount(
      0,
    );
  });
});

test.describe("JSON-LD", () => {
  test("artwork availability and Offer follow the live state", async ({
    page,
  }) => {
    await page.goto(`/en/works/${GALLERY_SLUG}`);
    const available = artworkLd(await jsonLd(page));
    expect(available.offers).toMatchObject({
      availability: "https://schema.org/InStock",
      price: "3200.00",
      priceCurrency: "ILS",
    });
    expect(available.sku).toMatch(/^A-\d{4}-\d{3}$/);
    expect(
      (await jsonLd(page)).some((b) => b["@type"] === "BreadcrumbList"),
    ).toBe(true);

    await page.goto("/en/works/reflection-in-the-pool");
    const sold = artworkLd(await jsonLd(page));
    expect(sold.offers?.availability).toBe("https://schema.org/SoldOut");
    expect(sold.offers?.price).toBeUndefined();

    await page.goto("/en/works/a-ship-in-the-heart-of-the-sea");
    expect(artworkLd(await jsonLd(page)).offers?.availability).toBe(
      "https://schema.org/Reserved",
    );

    await page.goto("/en/works/the-piano");
    expect(artworkLd(await jsonLd(page)).offers).toBeUndefined();

    await page.goto("/he");
    const org = (await jsonLd(page)).find((b) => b["@type"] === "Organization");
    expect(org).toMatchObject({
      hasMerchantReturnPolicy: { merchantReturnDays: 14 },
      hasShippingService: { "@type": "ShippingService" },
    });
  });

  test("pages carry canonical and hreflang alternates", async ({ page }) => {
    await page.goto(`/he/works/${GALLERY_SLUG}`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`/he/works/${GALLERY_SLUG}$`),
    );
    await expect(
      page.locator('link[rel="alternate"][hreflang="en"]'),
    ).toHaveAttribute("href", new RegExp(`/en/works/${GALLERY_SLUG}$`));
    await expect(
      page.locator('link[rel="alternate"][hreflang="x-default"]'),
    ).toHaveAttribute("href", new RegExp(`/he/works/${GALLERY_SLUG}$`));
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /\/api\/files\/public\/og\//,
    );
  });

  test("sitemap and robots", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    const body = await robots.text();
    expect(body).toContain("Disallow: /api/");
    expect(body).toMatch(/Sitemap: http.*\/sitemap\.xml/);
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    expect(xml).toContain(`/en/works/${GALLERY_SLUG}</loc>`);
    expect(xml).toContain('hreflang="x-default"');
    expect(xml).toContain("<image:loc>");
    expect(xml).not.toContain("/checkout/");
    expect(xml).not.toContain("/admin");
  });
});

test.describe("artwork page", () => {
  test("keyboard lightbox in Hebrew: mirrored arrows, live region, Esc, focus return", async ({
    page,
  }) => {
    await page.goto(`/he/works/${GALLERY_SLUG}`);
    const trigger = page.getByTestId("gallery-open");
    await expect(trigger).toBeVisible();
    // Wait for hydration: the thumbnails are interactive client buttons.
    await expect(
      page.getByRole("button", { name: /הצגת תמונה 2 מתוך 3/ }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "תצוגה מוגדלת" });
    await expect(async () => {
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass();
    const live = page.getByTestId("lightbox-live");
    await expect(live).toHaveText("תמונה 1 מתוך 3");
    await expect(live).toHaveAttribute("aria-live", "polite");
    // RTL: the left arrow moves forward.
    await page.keyboard.press("ArrowLeft");
    await expect(live).toHaveText("תמונה 2 מתוך 3");
    await page.keyboard.press("ArrowLeft");
    await expect(live).toHaveText("תמונה 3 מתוך 3");
    await page.keyboard.press("ArrowRight");
    await expect(live).toHaveText("תמונה 2 מתוך 3");
    await expect(dialog.getByRole("button", { name: "הגדלה" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("English lightbox: right arrow moves forward, close button", async ({
    page,
  }) => {
    await page.goto(`/en/works/${GALLERY_SLUG}`);
    await expect(
      page.getByRole("button", { name: /Show image 3 of 3/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Show image 3 of 3/ }).click();
    const trigger = page.getByRole("button", {
      name: /image 3 of 3, open the enlarged view/,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Enlarged view" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("lightbox-live")).toHaveText("Image 3 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("lightbox-live")).toHaveText("Image 2 of 3");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('"insured" appears only where the quote includes insurance', async ({
    page,
  }) => {
    // Seeded shipping settings: insurance enabled for DHL (international zones); the domestic
    // courier is never insured, so the trust row (cheapest Israeli quote) must not claim it.
    await page.goto(`/en/works/${GALLERY_SLUG}`);
    const box = page.getByTestId("buy-box");
    const trust = page.getByTestId("trust-row");
    await expect(trust).toContainText("Tracked delivery");
    await expect(trust).toContainText("14-day cancellation");
    await expect(trust).not.toContainText("Insured");
    await expect(
      box
        .locator("dt", { hasText: "North America" })
        .locator("xpath=following-sibling::dd[1]"),
    ).toContainText("insured");
    await expect(
      box
        .locator("dt", { hasText: /^Israel$/ })
        .locator("xpath=following-sibling::dd[1]"),
    ).not.toContainText("insured");

    // A quote-only work: no zone price, so no insurance claim anywhere.
    await page.goto("/en/works/reflection-in-yellow");
    await expect(page.getByTestId("buy-box")).not.toContainText(/insured/i);
  });
});

test.describe("home: the quote over By the Lake, then the bio", () => {
  for (const locale of ["he", "en"] as const) {
    test(`home and about show the bio; the hero quote links its painting (${locale})`, async ({
      page,
    }) => {
      const bio = messages(locale).bio as Record<string, string>;
      const home = messages(locale).home as { quote: { text: string } };
      await page.goto(`/${locale}`);
      const hero = page.getByTestId("home-hero");
      await expect(hero.locator("figure blockquote")).toHaveText(
        home.quote.text,
      );
      // The painting is the band's background (and the footer's), preloaded as the LCP.
      await expect(hero.getByTestId("painting-backdrop")).toHaveCount(1);
      await expect(
        page.getByTestId("site-footer").getByTestId("painting-backdrop"),
      ).toHaveCount(1);
      await expect(
        page.locator('link[rel="preload"][as="image"][fetchpriority="high"]'),
      ).toHaveCount(1);
      await expect(page.getByTestId("home-hero-caption")).toHaveAttribute(
        "href",
        `/${locale}/works/by-the-lake`,
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        bio.title as string,
      );
      await expect(page.getByTestId("artist-bio")).toContainText(
        bio.p6 as string,
      );
      // No sideways scroll from the full-bleed band.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await page.goto(`/${locale}/about`);
      await expect(
        page.getByRole("heading", { level: 2, name: bio.title }),
      ).toBeVisible();
      await expect(page.getByTestId("artist-bio")).toContainText(
        bio.p1 as string,
      );
    });
  }
});

test.describe("about and contact", () => {
  for (const locale of ["he", "en"] as const) {
    test(`about and contact render with the cancel link and Person JSON-LD (${locale})`, async ({
      page,
    }) => {
      const cancel = locale === "he" ? "ביטול עסקה" : "Cancel a purchase";
      for (const path of ["/about", "/contact"]) {
        const res = await page.goto(`/${locale}${path}`);
        expect(res?.status()).toBe(200);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        const link = page.getByRole("link", { name: cancel }).first();
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", `/${locale}/cancel`);
        expect((await jsonLd(page)).some((b) => b["@type"] === "Person")).toBe(
          true,
        );
      }
      const email = page.locator('a[href^="mailto:"] bdi').first();
      await expect(email).toHaveAttribute("dir", "ltr");
    });
  }

  test("the site never offers commissions", async ({ page }) => {
    for (const path of ["/en", "/en/contact", "/en/contact?topic=commission"]) {
      await page.goto(path);
      await expect(page.getByText(/commission/i)).toHaveCount(0);
    }
  });
});

test.describe("mobile @mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("scroll-snap strip with a counter, and the sticky buy bar", async ({
    page,
  }) => {
    await page.goto(`/he/works/${GALLERY_SLUG}`);
    const counter = page.getByTestId("gallery-counter");
    await expect(counter).toHaveText("1 / 3");
    const strip = page.getByTestId("gallery-strip");
    await expect(strip).toHaveCSS("scroll-snap-type", /x mandatory/);
    // RTL: scrolling towards the start side uses negative scrollLeft.
    await expect(async () => {
      await strip.evaluate((el) => {
        el.scrollTo({ left: -el.clientWidth, behavior: "instant" });
      });
      await expect(counter).toHaveText("2 / 3", { timeout: 1_000 });
    }).toPass();

    const bar = page.getByTestId("sticky-buy-bar");
    // Scroll just past the buy box: the bar takes over its call to action.
    await page.getByTestId("buy-box").evaluate((el) => {
      window.scrollBy(0, el.getBoundingClientRect().bottom + 10);
    });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("link", { name: "לרכישה" })).toHaveAttribute(
      "href",
      `/he/checkout/${GALLERY_SLUG}`,
    );
    const box = await bar.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    // The bar hides while the full buy box is on screen…
    await page.getByTestId("buy-box").scrollIntoViewIfNeeded();
    await expect(bar).toBeHidden();
    // …and never covers the footer's cancellation link.
    await page.locator("footer").scrollIntoViewIfNeeded();
    await expect(bar).toBeHidden();
  });
});
