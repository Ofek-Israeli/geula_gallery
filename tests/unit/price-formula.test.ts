import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formulaPriceIls,
  formulaPriceUsd,
  MEDIUMS,
  PRICING,
  type PricingMedium,
  type PricingSurface,
  SURFACES,
} from "@/lib/price-formula";
import { mediumEnum, surfaceEnum } from "@/server/db/schema";
import {
  asCatalogWork,
  type CatalogWork,
  catalogManifestSchema,
  MANIFEST_PATH,
} from "../../scripts/lib/catalog-manifest";

/**
 * The price formula (src/lib/price-formula.ts) and the examples quoted in
 * docs/pricing/pricing-procedure.tex: if a parameter changes, this test and the document change
 * together.
 */
const acrylic = (hCm: number, wCm: number) =>
  formulaPriceIls({
    heightMm: hCm * 10,
    widthMm: wCm * 10,
    medium: "ACRYLIC",
    surface: "CANVAS",
  });

const at80 = (medium: PricingMedium, surface: PricingSurface) =>
  formulaPriceIls({ heightMm: 800, widthMm: 800, medium, surface });

describe("price formula", () => {
  it("prices the reference work at the reference price", () => {
    expect(PRICING.referenceIls).toBe(4_800);
    expect(acrylic(80, 80)).toBe(4_800);
    expect(formulaPriceUsd(4_800)).toBe(1_300);
  });

  it("reproduces the procedure document's price list (acrylic on canvas)", () => {
    const list: [number, number, number][] = [
      [40, 60, 2_700],
      [60, 60, 3_400],
      [60, 80, 4_000],
      [70, 100, 5_100],
      [80, 80, 4_800],
      [80, 100, 5_500],
      [90, 90, 5_500],
      [80, 120, 6_100],
      [100, 100, 6_300],
      [100, 120, 7_000],
      [100, 150, 8_000],
      [120, 145, 8_700],
    ];
    for (const [h, w, price] of list) {
      expect(acrylic(h, w), `${h}×${w}`).toBe(price);
    }
  });

  it("applies the material factors of the document's examples", () => {
    expect(at80("OIL", "CANVAS")).toBe(5_500);
    expect(at80("ACRYLIC", "BOARD")).toBe(4_600);
    expect(at80("WATERCOLOR", "PAPER")).toBe(3_100);
    expect(
      formulaPriceIls({
        heightMm: 600,
        widthMm: 600,
        medium: "OIL",
        surface: "CANVAS",
      }),
    ).toBe(3_900);
  });

  it("ignores orientation and grows less than in proportion to the area", () => {
    expect(acrylic(60, 80)).toBe(acrylic(80, 60));
    // Twice the area (100 × 128 ≈ 2 × 80 × 80) costs 2^0.6 ≈ 1.52 times as much.
    const ratio = acrylic(100, 128) / acrylic(80, 80);
    expect(ratio).toBeGreaterThan(1.45);
    expect(ratio).toBeLessThan(1.6);
  });

  it("rounds the dollar price to $10 at the reference rate", () => {
    expect(formulaPriceUsd(8_700)).toBe(2_350);
    expect(formulaPriceUsd(4_000)).toBe(1_080);
  });

  it("has a factor for every medium and surface the database knows", () => {
    expect([...MEDIUMS].sort()).toEqual([...mediumEnum.enumValues].sort());
    expect([...SURFACES].sort()).toEqual([...surfaceEnum.enumValues].sort());
  });
});

describe("the catalog the demo seed lists", () => {
  const manifest = catalogManifestSchema.parse(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  );

  it("prices every non-fixture work in the manifest by the formula", () => {
    for (const w of manifest.works.filter((x) => !x.fixture)) {
      const ils = formulaPriceIls(w);
      expect(w.priceIls, w.slug).toBe(ils);
      expect(w.priceUsd, w.slug).toBe(formulaPriceUsd(ils));
    }
  });

  it("drops a fixture's test roles: available, formula prices, default shipping flags", () => {
    const fixture = manifest.works.find(
      (w) => w.fixture && w.quoteOnly,
    ) as CatalogWork;
    expect(fixture).toBeDefined();
    expect(asCatalogWork(fixture)).toMatchObject({
      status: "AVAILABLE",
      holdReason: null,
      priceIls: formulaPriceIls(fixture),
      quoteOnly: false,
      crate: false,
      canBeRolled: false,
      shipsInternationally: true,
    });
    const sold = manifest.works.find((w) => w.status === "SOLD") as CatalogWork;
    expect(asCatalogWork(sold).status).toBe("AVAILABLE");
  });
});
