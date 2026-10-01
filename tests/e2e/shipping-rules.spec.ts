import { expect, test } from "@playwright/test";
import { e2eExec } from "../helpers/factories/shipping";
import { e2eDatabaseUrl, e2eQuery, messages } from "./support/commerce";

/**
 * Spec §10.4 `shipping-rules` against the checkout page (read only: nothing is bought).
 * IR is hidden from the destination list; a VALUE_CAP destination routes to a quote; a crated,
 * quote-only work routes to a quote; GB at or under the low-value threshold is refused online.
 */
const co = messages("he", "checkout");

test("denied destinations are not offered", async ({ page }) => {
  await page.goto("/he/checkout/landscape-no-26");
  const options = page.locator("#co-country option");
  await expect(options.first()).toBeAttached();
  const values = await options.evaluateAll((els) =>
    els.map((e) => (e as HTMLOptionElement).value),
  );
  expect(values).toContain("US");
  for (const denied of ["IR", "SY", "LB", "IQ"]) {
    expect(values).not.toContain(denied);
  }
  // Even typed into the URL, a denied destination is refused.
  await page.goto("/he/checkout/landscape-no-26?to=IR");
  await expect(page.getByTestId("checkout-blocked")).toContainText(
    co.blocked.DESTINATION_DENIED,
  );
});

test("a declared value above the carrier cap routes to a quote", async ({
  page,
}) => {
  // E2E ships with the mock carrier, which has no cap by default: give it DHL's USD 2,500 cap
  // for this check (only abroad matters), then restore the settings row.
  const [row] = await e2eQuery<{ caps: unknown }>(
    "SELECT value->'valueCaps' AS caps FROM settings WHERE key = 'shipping'",
  );
  await e2eExec(
    e2eDatabaseUrl(),
    `UPDATE settings SET value = jsonb_set(value, '{valueCaps}', (value->'valueCaps') || '[{"carrier":"MOCK","maxUsd":2500}]'::jsonb) WHERE key = 'shipping'`,
  );
  try {
    // ₪12,500 > USD 2,500.
    await page.goto("/he/checkout/beach-at-cabasson?to=US");
    const blocked = page.getByTestId("checkout-blocked");
    await expect(blocked).toContainText(co.blocked.VALUE_CAP);
    await expect(
      blocked.getByRole("link", { name: co.blocked.requestQuote }),
    ).toBeVisible();
    // Under the cap the same destination is offered.
    await page.goto("/he/checkout/landscape-no-26?to=US");
    await expect(page.getByTestId("checkout-form")).toBeVisible();
  } finally {
    await e2eExec(
      e2eDatabaseUrl(),
      `UPDATE settings SET value = jsonb_set(value, '{valueCaps}', $1::jsonb) WHERE key = 'shipping'`,
      [JSON.stringify(row?.caps ?? [])],
    );
  }
});

test("a crated, quote-only work is quote only, even in Israel", async ({
  page,
}) => {
  await page.goto("/he/checkout/banks-of-the-durance?to=IL");
  const blocked = page.getByTestId("checkout-blocked");
  await expect(blocked).toContainText(co.blocked.QUOTE_ONLY);
  await expect(
    blocked.getByRole("link", { name: co.blocked.requestQuote }),
  ).toBeVisible();
});

test("GB at or under the low-value threshold is refused online", async ({
  page,
}) => {
  // The cheapest demo work is ₪1,900 (≈ GBP 404 at the seeded rate), above GBP 135. The threshold
  // is a setting: raise it for this check and restore it afterwards (only GB is affected).
  const [row] = await e2eQuery<{
    value: { thresholds: { gbLowValueGbp: number } };
  }>("SELECT value FROM settings WHERE key = 'shipping'");
  const original = row?.value.thresholds.gbLowValueGbp ?? 135;
  await e2eExec(
    e2eDatabaseUrl(),
    `UPDATE settings SET value = jsonb_set(value, '{thresholds,gbLowValueGbp}', '1000'::jsonb) WHERE key = 'shipping'`,
  );
  try {
    await page.goto("/he/checkout/antibes?to=GB");
    await expect(page.getByTestId("checkout-blocked")).toContainText(
      co.blocked.GB_LOW_VALUE,
    );
  } finally {
    await e2eExec(
      e2eDatabaseUrl(),
      `UPDATE settings SET value = jsonb_set(value, '{thresholds,gbLowValueGbp}', $1::jsonb) WHERE key = 'shipping'`,
      [JSON.stringify(original)],
    );
  }
  // Above the (restored) threshold GB falls in the disabled Europe zone: a quote.
  await page.goto("/he/checkout/antibes?to=GB");
  await expect(page.getByTestId("checkout-blocked")).toContainText(
    co.blocked.ZONE_DISABLED,
  );
});
