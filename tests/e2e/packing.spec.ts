import { expect, test } from "@playwright/test";
import { uniqueBuyer } from "../helpers/factories/core";
import {
  buyerIp,
  checkoutUrl,
  chooseDelivery,
  chooseDestination,
  cloneWork,
  continueToMockPay,
  e2eQuery,
  fillCheckout,
  messages,
} from "./support/commerce";

/**
 * The packing choice at checkout step 2: stretched (as listed, in a box) or rolled in a tube.
 * "ships-in-the-moonlight" (100×80) packs into a 112×92×11 cm box, too large for Israel Post;
 * rolled, it is a 90×26×26 cm tube that Israel Post takes. Each test has its own clone, marked
 * rollable as the painter's catalog is.
 */
const en = messages("en", "checkout");
const DOMESTIC = "e2e-pack-il";
const ABROAD = "e2e-pack-abroad";
const ARTWORK = "e2e-pack-art";

test.use({ extraHTTPHeaders: buyerIp(32) });
test.beforeAll(async () => {
  for (const slug of [DOMESTIC, ABROAD, ARTWORK]) {
    await cloneWork("ships-in-the-moonlight", slug);
  }
  await e2eQuery(
    "UPDATE artworks SET can_be_rolled = true WHERE slug = ANY($1)",
    [[DOMESTIC, ABROAD, ARTWORK]],
  );
});

test("Israel: rolled in a tube, the large canvas goes by Israel Post at ₪73", async ({
  page,
}) => {
  const buyer = uniqueBuyer("packing");
  await page.goto(`/en/checkout/${DOMESTIC}`);
  await chooseDestination(page, {
    locale: "en",
    city: "Haifa",
    zip: "3100000",
  });
  const form = page.getByTestId("delivery-form");
  const post = form.getByRole("radio", {
    name: new RegExp(`^${en.delivery.method.ISRAEL_POST}`),
  });
  const toggle = page.getByTestId("packing-toggle");
  // As listed (stretched, in its box): too large for Israel Post.
  await expect(toggle.getByTestId("packing-STRETCHED")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(post).toHaveCount(0);

  await toggle.getByTestId("packing-ROLLED").click();
  await expect(page).toHaveURL(/pack=rolled/);
  await expect(toggle.getByTestId("packing-ROLLED")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(post).toBeVisible();
  await expect(form.getByText(/₪73/)).toBeVisible();

  await chooseDelivery(page, { locale: "en", method: "ISRAEL_POST" });
  await expect(page.getByTestId("checkout-recap")).toContainText(
    en.delivery.packingRolledShort,
  );
  // The pre-contract disclosure says what arrives.
  await expect(page.getByTestId("precontract")).toContainText(
    "Rolled in a tube, off its stretcher",
  );
  await fillCheckout(page, {
    locale: "en",
    name: buyer.name,
    email: buyer.email,
    address: true,
  });
  const ref = await continueToMockPay(page);
  await page.getByTestId("mock-pay").click();
  await expect(page).toHaveURL(/payment=paid/);

  const [order] = await e2eQuery<{
    shipping_method: string;
    shipping_minor: number;
    packing: string | null;
  }>(
    `SELECT o.shipping_method, o.shipping_minor, o.shipping_quote->>'packing' AS packing
       FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
      WHERE pa.provider_ref = $1`,
    [ref],
  );
  expect(order).toEqual({
    shipping_method: "ISRAEL_POST",
    shipping_minor: 7300,
    packing: "ROLLED",
  });
});

test("abroad: rolled adds Israel Post EMS next to DHL Express", async ({
  page,
}) => {
  await page.goto(
    checkoutUrl(ABROAD, {
      to: "CA",
      city: "Toronto",
      zip: "M5V 2T6",
      step: "delivery",
    }),
  );
  const form = page.getByTestId("delivery-form");
  const radio = (name: string) =>
    form.getByRole("radio", { name: new RegExp(`^${name}`) });
  await expect(radio(en.delivery.method.DHL_EXPRESS)).toBeVisible();
  await expect(radio(en.delivery.method.ISRAEL_POST_EMS)).toHaveCount(0);

  await page.getByTestId("packing-ROLLED").click();
  await expect(radio(en.delivery.method.ISRAEL_POST_EMS)).toBeVisible();
  await expect(radio(en.delivery.method.DHL_EXPRESS)).toBeVisible();
});

test('the artwork page\'s "Delivery from" shows the cheaper rolled price, marked', async ({
  page,
}) => {
  await page.goto(`/en/works/${ARTWORK}`);
  // Stretched, Israel only has the courier (₪250); rolled, Israel Post home delivery.
  await expect(
    page.getByText("Delivery in Israel from ₪73 (rolled in a tube)"),
  ).toBeVisible();
});
