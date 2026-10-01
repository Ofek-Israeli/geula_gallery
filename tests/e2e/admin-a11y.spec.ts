import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "./e2e-env";
import { e2eQuery } from "./support/commerce";

/**
 * Spec §10.4 `a11y` (admin part, WS4): axe on the admin login, dashboard, artwork list and editor,
 * orders, inbox, settings and account, in Hebrew and English → zero serious or critical issues.
 * Read-only: no state is changed.
 */
async function audit(page: Page, path: string): Promise<void> {
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(200);
  await page.waitForLoadState("load");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const bad = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    bad.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
    path,
  ).toEqual([]);
}

for (const locale of ["he", "en"] as const) {
  test(`admin login (${locale}) has no serious axe issues`, async ({
    page,
  }) => {
    await audit(page, `/${locale}/admin/login`);
  });

  test.describe(`signed in (${locale})`, () => {
    test.use({ storageState: ADMIN_STORAGE_STATE });
    test(`admin pages (${locale}) have no serious axe issues`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const [art] = await e2eQuery<{ id: string }>(
        "SELECT id FROM artworks WHERE slug = 'landscape-no-26'",
      );
      const [order] = await e2eQuery<{ id: string }>(
        "SELECT id FROM orders ORDER BY created_at LIMIT 1",
      );
      const paths = [
        `/${locale}/admin`,
        `/${locale}/admin/artworks`,
        `/${locale}/admin/artworks/new`,
        `/${locale}/admin/artworks/${art?.id}`,
        `/${locale}/admin/orders`,
        `/${locale}/admin/orders/new`,
        `/${locale}/admin/inbox`,
        `/${locale}/admin/alerts`,
        `/${locale}/admin/settings`,
        `/${locale}/admin/settings/business`,
        `/${locale}/admin/settings/checkout`,
        `/${locale}/admin/account`,
        `/${locale}/admin/more`,
        ...(order ? [`/${locale}/admin/orders/${order.id}`] : []),
      ];
      for (const p of paths) await audit(page, p);
    });
  });
}
