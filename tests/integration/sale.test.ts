import { afterAll, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach, resetDatabase } from "../helpers/db";
import { testAdminContext } from "../helpers/factories/commerce";
import { insertArtwork } from "../helpers/factories/core";

/**
 * The site-wide sale (`checkout.sale`, `src/lib/sale.ts`): shown prices, the price filter, the
 * customs value and the checkout charge follow it; the list prices never change; saving the
 * checkout form keeps it.
 */
const { db } = await import("@/server/db/client");
const { getArtworkPage, listArtworks } = await import(
  "@/server/catalog/queries"
);
const { getCheckoutQuote } = await import("@/server/checkout/quote");
const { getSetting, saveSetting } = await import("@/server/settings");
const { saveCheckoutSettings, saveSaleSettings, saveWorkSalePercent } =
  await import("@/server/admin/settings");

cleanDatabaseBeforeEach();
afterAll(() => resetDatabase());

const ctx = testAdminContext();
const SALE = {
  enabled: true,
  percentOff: 50,
  startsOn: "2026-01-01",
  endsOn: "2099-12-31",
  label: { he: "מבצע סוף שנה – 50% הנחה", en: "End-of-Year Sale – 50% Off" },
  perWork: {} as Record<string, number>,
};

async function startSale(over: Partial<typeof SALE> = {}) {
  const checkout = await getSetting("checkout");
  await saveSetting(ctx, "checkout", {
    ...checkout,
    sale: { ...SALE, ...over },
  });
}

describe("the site-wide sale", () => {
  it("shows the sale price with the list price and its last day; the list price stays", async () => {
    const a = await insertArtwork(db, {
      priceIlsMinor: 400_000,
      priceUsdMinor: 110_000,
    });
    await startSale();
    const page = await getArtworkPage("en", a.slug);
    expect(page?.artwork.price).toEqual({
      ilsMinor: 200_000,
      usdMinor: 55_000,
      onRequest: false,
      wasIlsMinor: 400_000,
      wasUsdMinor: 110_000,
      saleEndsOn: "2099-12-31",
    });
    // Customs and insurance follow the price actually paid.
    expect(page?.declaredValueIlsMinor).toBe(200_000);

    // Ended yesterday: back to the list price, with nothing crossed out.
    await startSale({ startsOn: "2020-01-01", endsOn: "2020-12-31" });
    const after = await getArtworkPage("en", a.slug);
    expect(after?.artwork.price).toMatchObject({
      ilsMinor: 400_000,
      wasIlsMinor: null,
      saleEndsOn: null,
    });
  });

  it("filters the price bands by the sale price", async () => {
    const cheap = await insertArtwork(db, { priceIlsMinor: 400_000 });
    const dear = await insertArtwork(db, { priceIlsMinor: 1_000_000 });
    const band = { priceMinIlsMinor: 150_000, priceMaxIlsMinor: 250_000 };
    expect((await listArtworks("en", band)).items).toEqual([]);
    await startSale();
    const slugs = (await listArtworks("en", band)).items.map((w) => w.slug);
    expect(slugs).toEqual([cheap.slug]);
    expect(slugs).not.toContain(dear.slug);
  });

  it("gives a single work its own percentage, on the page, in the bands and at checkout", async () => {
    const dancer = await insertArtwork(db, {
      priceIlsMinor: 1_250_000,
      priceUsdMinor: 340_000,
      isDemo: true,
    });
    const other = await insertArtwork(db, { priceIlsMinor: 1_250_000 });
    await startSale();
    await saveWorkSalePercent(ctx, dancer.id, 20);
    const page = await getArtworkPage("en", dancer.slug);
    expect(page?.artwork.price).toMatchObject({
      ilsMinor: 1_000_000,
      wasIlsMinor: 1_250_000,
      usdMinor: 272_000,
    });
    expect(
      (await getArtworkPage("en", other.slug))?.artwork.price.ilsMinor,
    ).toBe(625_000);
    // ₪10,000 is in the 10,000–20,000 band; the other work (₪6,250) is not.
    const band = (
      await listArtworks("en", {
        priceMinIlsMinor: 1_000_000,
        priceMaxIlsMinor: 2_000_000,
      })
    ).items.map((w) => w.slug);
    expect(band).toEqual([dancer.slug]);
    const quote = await getCheckoutQuote({
      slug: dancer.slug,
      locale: "en",
      country: "IL",
    });
    expect(quote.kind === "ok" && quote.items[0]?.priceMinor).toBe(1_000_000);

    // Saving the sale box keeps it; clearing it brings back the sale's percentage.
    await saveSaleSettings(ctx, {
      enabled: true,
      percentOff: 50,
      startsOn: null,
      endsOn: null,
      label: SALE.label,
    });
    expect((await getSetting("checkout")).sale.perWork).toEqual({
      [dancer.id]: 20,
    });
    await saveWorkSalePercent(ctx, dancer.id, null);
    expect(
      (await getArtworkPage("en", dancer.slug))?.artwork.price.ilsMinor,
    ).toBe(625_000);
  });

  it("charges the sale price at checkout", async () => {
    const a = await insertArtwork(db, {
      priceIlsMinor: 400_000,
      isDemo: true,
    });
    await startSale();
    const quote = await getCheckoutQuote({
      slug: a.slug,
      locale: "en",
      country: "IL",
    });
    expect(quote.kind).toBe("ok");
    if (quote.kind === "ok") {
      expect(quote.items[0]?.priceMinor).toBe(200_000);
      expect(quote.itemsTotalMinor).toBe(200_000);
    }
  });

  it("is kept when the checkout form is saved, and saved on its own", async () => {
    await startSale();
    const { sale: _sale, ...form } = await getSetting("checkout");
    await saveCheckoutSettings(ctx, { ...form, maxCartItems: 7 });
    let checkout = await getSetting("checkout");
    expect(checkout.maxCartItems).toBe(7);
    expect(checkout.sale).toEqual(SALE);

    await saveSaleSettings(ctx, { ...SALE, enabled: false });
    checkout = await getSetting("checkout");
    expect(checkout.sale.enabled).toBe(false);
    expect(checkout.maxCartItems).toBe(7);
  });
});
