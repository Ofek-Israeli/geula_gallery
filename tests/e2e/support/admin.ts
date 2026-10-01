/**
 * Shared steps for the WS4 admin E2E specs (admin-artwork, admin-offline, quote, manual-order).
 * Every spec creates its own works through the admin editor, so they never compete with other
 * streams for the seeded demo works.
 */
import {
  type Browser,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { uniqueSuffix } from "../../helpers/factories/core";
import { ADMIN_STORAGE_STATE } from "../e2e-env";
import { messages } from "./commerce";

export const HE = {
  catalog: messages("he", "admin-catalog"),
  shell: messages("he", "admin-shell"),
  orders: messages("he", "admin-orders"),
  requests: messages("he", "requests"),
  form: messages("he", "common").form,
} as const;

/** A demo-catalog JPEG (committed) used as the upload fixture. */
export const IMAGE_FIXTURE = "data/demo-images/100476.jpg";

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A form control by the start of its visible label (labels may end with "(חובה)"). */
export function field(scope: Page | Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^${escapeRe(label)}`));
}

export async function adminContext(browser: Browser) {
  return browser.newContext({ storageState: ADMIN_STORAGE_STATE });
}

/**
 * Clicks a submit button that may open a confirmation dialog (client handler: retry until the
 * dialog is visible, since a click before hydration does nothing), then confirms.
 */
export async function submitWithConfirm(
  form: Locator,
  buttonName: string,
  confirmName: string,
): Promise<void> {
  const page = form.page();
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await form.getByRole("button", { name: buttonName, exact: true }).click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await dialog.getByRole("button", { name: confirmName, exact: true }).click();
}

export interface CreatedArtwork {
  id: string;
  slug: string;
  titleHe: string;
  titleEn: string;
}

/** Fills the "new artwork" form and lands on the editor. */
export async function createDraftArtwork(
  page: Page,
  opts: { prefix?: string } = {},
): Promise<CreatedArtwork> {
  const s = uniqueSuffix(6);
  const titleEn = `${opts.prefix ?? "E2E work"} ${s}`;
  const titleHe = `יצירת בדיקה ${s}`;
  const c = HE.catalog;
  await page.goto("/he/admin/artworks/new");
  const form = page.getByTestId("new-artwork-form");
  await field(form, c.fields.titleHe).fill(titleHe);
  await field(form, c.fields.titleEn).fill(titleEn);
  await field(form, c.fields.heightCm).fill("60");
  await field(form, c.fields.widthCm).fill("80");
  await field(form, c.fields.depthCm).fill("3");
  await form.getByRole("button", { name: c.new.submit }).click();
  await expect(page).toHaveURL(
    /\/he\/admin\/artworks\/[0-9a-f-]{36}\?created=1/,
  );
  const id = /artworks\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  const slug = titleEn.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { id, slug, titleHe, titleEn };
}

export async function uploadPhoto(page: Page): Promise<void> {
  const before = await page.getByTestId("artwork-image").count();
  const upload = page.getByTestId("photo-upload");
  await upload.locator('input[type="file"]').setInputFiles(IMAGE_FIXTURE);
  await upload.getByRole("button", { name: HE.catalog.photos.upload }).click();
  await expect(page.getByTestId("photo-upload-result")).toHaveText(
    HE.catalog.photos.uploaded,
  );
  await expect(page.getByTestId("artwork-image")).toHaveCount(before + 1);
}

export async function fillAltTexts(page: Page): Promise<void> {
  const c = HE.catalog;
  const form = page.getByTestId("image-form").first();
  await field(form, c.fields.altHe).fill("ציור שמן של נוף בגוונים כחולים");
  await field(form, c.fields.altEn).fill(
    "Oil painting of a landscape in blues",
  );
  await form.getByRole("button", { name: HE.shell.common.save }).click();
  await expect(form.getByTestId("form-success")).toBeVisible();
}

/** Price, packing (suggestion), customs: everything but the alt texts. */
export async function fillSaleDetails(
  page: Page,
  opts: { ils?: string; usd?: string } = {},
): Promise<void> {
  const c = HE.catalog;
  const price = page.getByTestId("price-form");
  await field(price, c.fields.priceIls).fill(opts.ils ?? "2400");
  await field(price, c.fields.priceUsd).fill(opts.usd ?? "650");
  await price.getByRole("button", { name: HE.shell.common.save }).click();
  await expect(price.getByTestId("form-success")).toBeVisible();

  const shipping = page.getByTestId("shipping-form");
  await expect(async () => {
    await shipping.getByRole("button", { name: /^שימוש בהצעה/ }).click();
    await expect(field(shipping, c.fields.packedLengthCm)).not.toHaveValue("", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await shipping.getByRole("button", { name: HE.shell.common.save }).click();
  await expect(shipping.getByTestId("form-success")).toBeVisible();

  const customs = page.getByTestId("customs-form");
  await field(customs, c.fields.customsDescriptionEn).fill(
    "Original oil painting on canvas, signed by the artist",
  );
  await customs.getByRole("button", { name: HE.shell.common.save }).click();
  await expect(customs.getByTestId("form-success")).toBeVisible();
}

export async function publish(page: Page): Promise<void> {
  const form = page.getByTestId("publish-form");
  await form
    .getByRole("button", { name: HE.catalog.checklist.publish })
    .click();
  await expect(page.getByTestId("artwork-published")).toHaveText(
    HE.catalog.list.published,
  );
}

/** A complete, published work created through the editor (≈ 10 s). */
export async function createPublishedArtwork(
  page: Page,
  opts: { prefix?: string; ils?: string; usd?: string } = {},
): Promise<CreatedArtwork> {
  const a = await createDraftArtwork(page, opts);
  await uploadPhoto(page);
  await fillAltTexts(page);
  await fillSaleDetails(page, opts);
  await publish(page);
  return a;
}
