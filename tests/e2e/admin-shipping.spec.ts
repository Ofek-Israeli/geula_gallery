import { expect, test } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "./e2e-env";

/**
 * The DHL Express estimate group of `/admin/settings/shipping`: its fields carry the stored values
 * and the read-only panel names the published tariff and links DHL's pages. Read-only: nothing is
 * saved (a changed fuel surcharge would change every quote abroad in the other specs).
 */
test.describe("admin shipping settings: DHL Express estimate", () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test("shows the fields, the tariff and DHL's pages", async ({ page }) => {
    await page.goto("/en/admin/settings/shipping");
    const group = page.getByRole("group", {
      name: "DHL Express estimate (abroad)",
    });
    await expect(group).toBeVisible();
    await expect(
      group.getByLabel("Price shipments abroad by the DHL estimate"),
    ).toBeChecked();
    await expect(group.getByLabel("Fuel surcharge (%)")).toHaveValue("49");
    await expect(group.getByLabel("Fuel surcharge valid from")).toHaveValue(
      "2026-10-12",
    );
    await expect(
      group.getByLabel("Account discount off DHL's prices (%)"),
    ).toHaveValue("0");
    await expect(page.getByTestId("dhl-tariff")).toContainText(
      "DHL Express Service & Rate Guide 2026: Israel",
    );
    await expect(
      page.getByRole("link", { name: "Rate guide 2026 (PDF)" }),
    ).toHaveAttribute("href", /rate_guide_il_en_2026/);
  });

  test("Hebrew: the group and the tariff panel", async ({ page }) => {
    await page.goto("/he/admin/settings/shipping");
    await expect(
      page.getByRole("group", { name: "הערכת DHL Express (חו״ל)" }),
    ).toBeVisible();
    await expect(page.getByTestId("dhl-tariff")).toContainText("2026");
  });
});
