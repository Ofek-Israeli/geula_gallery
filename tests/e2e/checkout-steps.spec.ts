import { expect, test } from "@playwright/test";
import {
  checkoutUrl,
  chooseDelivery,
  chooseDestination,
  cloneWork,
  messages,
  seriousAxeViolations,
} from "./support/commerce";

/**
 * The address-first checkout (`src/lib/checkout-steps.ts`): 1. country, city and postal code →
 * 2. the priced delivery options (and the currency abroad) → 3. the details, with a street address
 * only for a delivery. Both step forms are GET forms that work without JavaScript; "Change" links
 * go back with everything prefilled; a method the destination does not offer stays on step 2 with
 * a notice; a blocked destination keeps the step 1 form, prefilled. Read only: nothing is bought.
 */
const en = messages("en", "checkout");
const DOMESTIC = "e2e-steps-domestic";

test.beforeAll(async () => cloneWork("lone-home", DOMESTIC));

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("pickup: destination → delivery → details with no street address, and back through Change", async ({
    page,
  }) => {
    await page.goto("/en/checkout/the-path");
    const current = page
      .getByTestId("checkout-steps")
      .locator('[aria-current="step"]');
    await expect(current).toContainText(en.steps.destination);
    await expect(page.locator("#co-country")).toHaveValue("IL");

    // Continue with nothing typed: a city is required (Israel needs no postal code).
    await page.getByTestId("destination-continue").click();
    const destination = page.getByTestId("checkout-destination");
    await expect(destination.getByRole("alert")).toContainText(
      en.destination.errors.cityRequired,
    );
    await expect(page.locator("#co-city")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator("#co-postal")).not.toHaveAttribute(
      "aria-invalid",
    );

    // Haifa: the three options for Israel.
    await chooseDestination(page, { locale: "en", city: "Haifa" });
    await expect(current).toContainText(en.steps.delivery);
    await expect(
      page.getByTestId("delivery-form").getByRole("radio"),
    ).toHaveCount(3);
    await expect(page.getByTestId("checkout-recap")).toContainText("Haifa");
    await chooseDelivery(page, { locale: "en", method: "LOCAL_PICKUP" });

    // Step 3 for a pickup: no street address, and neither city nor postal code is posted.
    await expect(current).toContainText(en.steps.details);
    await expect(page.getByTestId("checkout-form")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /^Street and number/ }),
    ).toHaveCount(0);
    await expect(page.locator('input[name="city"]')).toHaveCount(0);
    await expect(page.locator('input[name="postalCode"]')).toHaveCount(0);
    await expect(page.getByTestId("checkout-recap")).toContainText(
      en.delivery.method.LOCAL_PICKUP,
    );

    // Change destination: step 1 prefilled and without errors; Continue keeps the pickup.
    await page.getByTestId("change-destination").click();
    await expect(destination).toBeVisible();
    await expect(page.locator("#co-city")).toHaveValue("Haifa");
    await expect(destination.getByRole("alert")).toHaveCount(0);
    await page.getByTestId("destination-continue").click();
    await expect(page.getByTestId("checkout-delivery")).toBeVisible();
    await expect(page.locator("#ship-LOCAL_PICKUP")).toBeChecked();
  });

  test("courier: step 3 posts the destination's city and postal code", async ({
    page,
  }) => {
    await page.goto(checkoutUrl("the-path", { ship: "CARRIER_TABLE" }));
    const form = page.getByTestId("checkout-form");
    await expect(form.locator('input[name="city"]')).toHaveValue("Tel Aviv");
    await expect(form.locator('input[name="city"]')).toHaveAttribute(
      "type",
      "hidden",
    );
    await expect(form.locator('input[name="postalCode"]')).toHaveValue(
      "6100000",
    );
    await expect(
      form.getByRole("textbox", { name: /^Street and number/ }),
    ).toBeVisible();
    await expect(form.getByRole("textbox", { name: /^City/ })).toHaveCount(0);
    await expect(page.getByTestId("details-destination")).toContainText(
      "Tel Aviv 6100000, Israel",
    );
  });
});

test("a postal code is required abroad, unless the destination has none", async ({
  page,
}) => {
  await page.goto("/en/checkout/the-path");
  await chooseDestination(page, {
    locale: "en",
    to: "US",
    city: "Springfield",
  });
  await expect(
    page.getByTestId("checkout-destination").getByRole("alert"),
  ).toContainText(en.destination.errors.postalRequired);
  await expect(page.locator("#co-postal")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  // Hong Kong has no postal codes.
  await chooseDestination(page, { locale: "en", to: "HK", city: "Kowloon" });
  await expect(page.getByTestId("checkout-delivery")).toBeVisible();
  await expect(page.getByTestId("checkout-recap")).toContainText("Kowloon");
});

test("a method the destination does not offer stays on the delivery step with a notice", async ({
  page,
}) => {
  await page.goto(
    checkoutUrl("the-path", {
      to: "US",
      city: "Springfield",
      zip: "62701",
      ship: "LOCAL_PICKUP",
    }),
  );
  const delivery = page.getByTestId("checkout-delivery");
  await expect(delivery.getByRole("alert")).toContainText(
    en.delivery.unavailable,
  );
  await expect(page.locator("#ship-CARRIER_TABLE")).toBeChecked();
  await expect(page.locator("#ship-LOCAL_PICKUP")).toHaveCount(0);
});

test("currency links show the current currency, and Change delivery keeps it", async ({
  page,
}) => {
  await page.goto(
    checkoutUrl("the-path", {
      to: "US",
      city: "Springfield",
      zip: "62701",
      step: "delivery",
    }),
  );
  const toggle = page.getByTestId("currency-toggle");
  const ils = toggle.getByRole("link", { name: en.delivery.currencyIls });
  const usd = toggle.getByRole("link", { name: en.delivery.currencyUsd });
  await expect(ils).toHaveAttribute("aria-current", "true");
  await expect(usd).not.toHaveAttribute("aria-current");
  await usd.click();
  await expect(page).toHaveURL(/cur=USD/);
  await expect(usd).toHaveAttribute("aria-current", "true");
  await expect(ils).not.toHaveAttribute("aria-current");

  await chooseDelivery(page, { locale: "en", method: "CARRIER_TABLE" });
  await expect(page.getByTestId("checkout-total")).toContainText("$");
  await page.getByTestId("change-delivery").click();
  await expect(page).toHaveURL(/cur=USD/);
  await expect(page).toHaveURL(/step=delivery/);
  await expect(page.locator("#ship-CARRIER_TABLE")).toBeChecked();
  await expect(usd).toHaveAttribute("aria-current", "true");
});

test("a blocked destination keeps the destination form, prefilled", async ({
  page,
}) => {
  await page.goto(
    checkoutUrl(DOMESTIC, {
      to: "US",
      city: "Springfield",
      zip: "62701",
      step: "delivery",
    }),
  );
  await expect(page.getByTestId("checkout-blocked")).toContainText(
    en.blocked.NOT_INTERNATIONAL,
  );
  const form = page.getByTestId("destination-form");
  await expect(form.locator("#co-country")).toHaveValue("US");
  await expect(form.locator("#co-city")).toHaveValue("Springfield");
  await expect(form.locator("#co-postal")).toHaveValue("62701");
  // Back to Israel from the same form: the delivery step.
  await form.locator("#co-country").selectOption("IL");
  await form.getByTestId("destination-continue").click();
  await expect(page.getByTestId("checkout-delivery")).toBeVisible();
});

for (const locale of ["he", "en"] as const) {
  test(`axe: every checkout step and the blocked form (${locale})`, async ({
    page,
  }) => {
    const us = { locale, to: "US", city: "Springfield", zip: "62701" };
    for (const [path, testId] of [
      [`/${locale}/checkout/the-path`, "checkout-destination"],
      // Step 1 with errors (no city, no postal code for the US).
      [
        `/${locale}/checkout/the-path?to=US&step=delivery`,
        "checkout-destination",
      ],
      [
        checkoutUrl("the-path", { locale, step: "delivery" }),
        "checkout-delivery",
      ],
      // Abroad: the currency links and the "not available here" notice.
      [
        checkoutUrl("the-path", { ...us, ship: "LOCAL_PICKUP" }),
        "checkout-delivery",
      ],
      [
        checkoutUrl("the-path", { locale, ship: "LOCAL_PICKUP" }),
        "checkout-form",
      ],
      [
        checkoutUrl("the-path", { ...us, ship: "CARRIER_TABLE" }),
        "checkout-form",
      ],
      [checkoutUrl(DOMESTIC, us), "destination-form"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByTestId(testId)).toBeVisible();
      expect(await seriousAxeViolations(page), path).toEqual([]);
    }
  });
}
