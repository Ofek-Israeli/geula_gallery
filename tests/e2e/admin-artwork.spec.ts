import { expect, test } from "@playwright/test";
import { ADMIN_STORAGE_STATE } from "./e2e-env";
import {
  createDraftArtwork,
  field,
  fillAltTexts,
  fillSaleDetails,
  HE,
  publish,
  uploadPhoto,
} from "./support/admin";
import { e2eQuery } from "./support/commerce";

/**
 * Spec §10.4 `admin-artwork`: create a work, upload a photo, publishing is blocked until the alt
 * texts are filled, then it is visible on the site; a price change needs confirmation and is
 * audited.
 */
test.use({ storageState: ADMIN_STORAGE_STATE });

const c = HE.catalog;

test("create → upload → publish blocked until alt texts → visible → confirmed, audited price change", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const a = await createDraftArtwork(page, { prefix: "Artwork editor" });
  await expect(page.getByTestId("artwork-published")).toHaveText(c.list.draft);
  await uploadPhoto(page);
  // The first photo becomes MAIN; its alt texts start empty.
  await expect(page.getByTestId("checklist-mainImage")).toHaveAttribute(
    "data-ok",
    "true",
  );
  await expect(page.getByTestId("checklist-altTexts")).toHaveAttribute(
    "data-ok",
    "false",
  );
  await fillSaleDetails(page);

  // Publishing is refused while an alt text is missing.
  const publishForm = page.getByTestId("publish-form");
  await publishForm.getByRole("button", { name: c.checklist.publish }).click();
  await expect(publishForm.getByTestId("form-error")).toHaveText(
    c.errors.PUBLISH_CHECKLIST,
  );
  await expect(page.getByTestId("artwork-published")).toHaveText(c.list.draft);
  const hidden = await page.goto(`/he/works/${a.slug}`);
  expect(hidden?.status()).toBe(404);
  await page.goto(`/he/admin/artworks/${a.id}`);

  await fillAltTexts(page);
  await expect(page.getByTestId("checklist-altTexts")).toHaveAttribute(
    "data-ok",
    "true",
  );
  await publish(page);

  // Visible on the site, with its price.
  await page.goto(`/he/works/${a.slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(a.titleHe);
  await expect(page.getByTestId("artwork-status")).toBeVisible();
  await expect(page.locator("main")).toContainText("2,400");

  // The slug is locked after the first publish.
  await page.goto(`/he/admin/artworks/${a.id}`);
  await expect(
    field(page.getByTestId("details-form"), c.fields.slug),
  ).toHaveAttribute("readonly", "");

  // A price change asks for confirmation, then is saved and audited.
  const price = page.getByTestId("price-form");
  await field(price, c.fields.priceIls).fill("2600");
  await price.getByRole("button", { name: HE.shell.common.save }).click();
  await expect(price.getByTestId("form-error")).toHaveText(
    c.errors.PRICE_CONFIRM_REQUIRED,
  );
  await price.getByLabel(c.fields.confirmPriceChange).check();
  await price.getByRole("button", { name: HE.shell.common.save }).click();
  await expect(price.getByTestId("form-success")).toBeVisible();

  const audit = await e2eQuery<{
    before: { priceIlsMinor: number };
    after: { priceIlsMinor: number };
  }>(
    "SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'artwork.price_changed'",
    [a.id],
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]?.before.priceIlsMinor).toBe(240_000);
  expect(audit[0]?.after.priceIlsMinor).toBe(260_000);
  await page.goto(`/he/works/${a.slug}`);
  await expect(page.locator("main")).toContainText("2,600");
});
