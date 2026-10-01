import { expect, test } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "./e2e-env";

/**
 * Smoke (spec §10.4): locale redirects, `html[dir][lang]`, demo banner, X-Robots-Tag, the
 * cancellation link on every public page, and the admin guard. Pages that later milestones
 * build are listed with `test.fixme` and the milestone that adds them; whoever lands the page
 * removes the `fixme`.
 */

test.describe("locale routing @smoke", () => {
  test("/ redirects to /he by default (307)", async ({ request }) => {
    const res = await request.get("/", {
      maxRedirects: 0,
      headers: { "Accept-Language": "he-IL,he;q=0.9" },
    });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location ?? "", "http://x").pathname).toBe(
      "/he",
    );
  });

  test("/ redirects English browsers to /en", async ({ request }) => {
    const res = await request.get("/", {
      maxRedirects: 0,
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    expect(res.status()).toBe(307);
    expect(new URL(res.headers().location ?? "", "http://x").pathname).toBe(
      "/en",
    );
  });

  for (const [locale, dir] of [
    ["he", "rtl"],
    ["en", "ltr"],
  ] as const) {
    test(`/${locale} renders lang=${locale} dir=${dir} with the demo banner`, async ({
      page,
    }) => {
      const res = await page.goto(`/${locale}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      // DEMO_MODE=true: bilingual banner in both languages, current locale first.
      const banner = page.locator("aside").first();
      await expect(banner.locator('[lang="he"]')).toBeVisible();
      await expect(banner.locator('[lang="en"]')).toBeVisible();
      await expect(banner.locator("span").first()).toHaveAttribute(
        "lang",
        locale,
      );
    });
  }

  test("demo pages are noindex (X-Robots-Tag)", async ({ request }) => {
    for (const path of ["/he", "/en", "/he/admin/login"]) {
      const res = await request.get(path);
      expect(res.headers()["x-robots-tag"], path).toContain("noindex");
    }
  });

  test("unknown paths render the not-found page", async ({ request }) => {
    const res = await request.get("/he/definitely-not-a-page");
    expect(res.status()).toBe(404);
  });
});

test.describe("cancellation link on public pages @smoke", () => {
  const cancelName = { he: "ביטול עסקה", en: "Cancel a purchase" } as const;

  for (const locale of ["he", "en"] as const) {
    test(`home (${locale}) links to /${locale}/cancel`, async ({ page }) => {
      await page.goto(`/${locale}`);
      const links = page.getByRole("link", { name: cancelName[locale] });
      // Header and footer (spec §1.2).
      await expect(links.first()).toBeVisible();
      expect(await links.count()).toBeGreaterThanOrEqual(1);
      await expect(links.first()).toHaveAttribute("href", `/${locale}/cancel`);
    });
  }

  for (const [name, path] of [
    ["works", "/works"],
    ["artwork", "/works/landscape-no-26"],
  ] as const) {
    for (const locale of ["he", "en"] as const) {
      test(`${name} page (${locale}) links to /${locale}/cancel`, async ({
        page,
      }) => {
        const res = await page.goto(`/${locale}${path}`);
        expect(res?.status()).toBe(200);
        const link = page
          .getByRole("link", { name: cancelName[locale] })
          .first();
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", `/${locale}/cancel`);
      });
    }
  }

  for (const [page, owner] of [
    ["about", "WS1"],
    ["legal", "WS6"],
    ["checkout", "M2 checkout"],
    ["order", "M2 order page"],
  ] as const) {
    test.fixme(`${page} page shows the cancellation link (lands in ${owner})`, () => {});
  }
});

test.describe("admin guard @smoke", () => {
  test("logged out, /he/admin redirects to the login page", async ({
    page,
  }) => {
    await page.goto("/he/admin");
    await expect(page).toHaveURL(/\/he\/admin\/login(\?|$)/);
    await expect(page.locator('input[name="email"]')).toBeVisible();
  });

  test("a forged session cookie does not reach the dashboard", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "forged.forged",
        url: baseURL ?? "http://localhost",
      },
    ]);
    await page.goto("/he/admin");
    await expect(page).toHaveURL(/\/he\/admin\/login(\?|$)/);
  });

  test.describe("signed in", () => {
    test.use({ storageState: ADMIN_STORAGE_STATE });

    test("the seeded E2E admin reaches the dashboard", async ({ page }) => {
      const res = await page.goto("/he/admin");
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(/\/he\/admin\/?$/);
      expect(res?.headers()["cache-control"]).toContain("no-store");
    });
  });
});

test.describe("health", () => {
  test("GET /api/health reports the database as up", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
