import { describe, expect, it } from "vitest";
import {
  anyRollable,
  type PricedArtwork,
  shippingOptions,
} from "@/server/checkout/pricing";
import {
  rollableAtCheckout,
  rolledSpec,
  rolledWeightG,
  zoneEstimates,
} from "@/server/shipping/rates";
import type { ArtworkShipSpec } from "@/server/shipping/types";
import { demoPackaging } from "../../scripts/seed/packaging";
import {
  checkoutDefaults,
  shippingDefaults,
} from "../../scripts/seed/settings";

/**
 * The buyer's packing choice (checkout step 2): a stretched canvas in its box, or rolled in a tube
 * off its stretcher (`rates.ts#rolledSpec`), which makes large paintings fit Israel Post.
 */
const settings = shippingDefaults;
const DAY = new Date("2026-10-15T09:00:00Z");
const DOMESTIC = settings.israelPost.estimate.domestic;
const ABROAD = settings.israelPost.estimate.abroad;

/** A painter's canvas as the catalog seed stores it: boxed, rollable at the buyer's choice. */
function canvas(hCm: number, wCm: number, canBeRolled = true): PricedArtwork {
  const p = demoPackaging({
    heightMm: hCm * 10,
    widthMm: wCm * 10,
    surface: "CANVAS",
    canBeRolled: false,
    crate: false,
  });
  return {
    id: `w-${hCm}x${wCm}`,
    priceIlsMinor: 400_000,
    priceUsdMinor: 110_000,
    priceOnRequest: false,
    declaredValueOverrideMinor: null,
    heightMm: hCm * 10,
    widthMm: wCm * 10,
    depthMm: null,
    packagingType: p.packagingType,
    canBeRolled,
    packedLengthMm: p.packedLengthMm,
    packedWidthMm: p.packedWidthMm,
    packedHeightMm: p.packedHeightMm,
    packedWeightG: p.packedWeightG,
    sizeClassOverride: null,
    glazing: "NONE",
    framed: false,
    shipsInternationally: true,
    localPickupOnly: false,
    quoteOnly: false,
    maxInsurableValueMinor: null,
    dispatchDays: 5,
  };
}

const spec = (a: PricedArtwork): ArtworkShipSpec => ({
  ...a,
  artworkId: a.id,
  packedLengthMm: a.packedLengthMm as number,
  packedWidthMm: a.packedWidthMm as number,
  packedHeightMm: a.packedHeightMm as number,
  packedWeightG: a.packedWeightG as number,
});

const options = (a: PricedArtwork, country: string, rolled: boolean) =>
  shippingOptions({
    items: [a],
    country,
    currency: "ILS",
    date: DAY,
    shipping: settings,
    checkout: checkoutDefaults,
    carrier: "DHL",
    ...(rolled ? { packing: "ROLLED" as const } : {}),
  });

describe("the rolled variant", () => {
  it("is a tube of the shorter side + 10 cm, at the rolled weight, with no class override", () => {
    const a = spec({ ...canvas(100, 140), sizeClassOverride: "M" });
    expect(rollableAtCheckout(a)).toBe(true);
    expect(rolledSpec(a)).toMatchObject({
      packagingType: "ROLLED_TUBE",
      packedLengthMm: 1100,
      packedWidthMm: 260,
      packedHeightMm: 260,
      // 1.5 kg + 1.2 kg/m² × 1.4 m²
      packedWeightG: 3180,
      sizeClassOverride: null,
    });
    expect(rolledWeightG({ heightMm: 1000, widthMm: 1000 })).toBe(2700);
  });

  it("is not offered for a framed, glazed or crated work, a tube, or a work the painter keeps stretched", () => {
    const a = spec(canvas(100, 100));
    expect(rollableAtCheckout({ ...a, framed: true })).toBe(false);
    expect(rollableAtCheckout({ ...a, glazing: "ACRYLIC" })).toBe(false);
    expect(rollableAtCheckout({ ...a, packagingType: "CRATE" })).toBe(false);
    expect(rollableAtCheckout({ ...a, packagingType: "ROLLED_TUBE" })).toBe(
      false,
    );
    expect(rollableAtCheckout({ ...a, canBeRolled: false })).toBe(false);
    expect(anyRollable([canvas(100, 100, false)])).toBe(false);
    expect(anyRollable([canvas(100, 100, false), canvas(40, 50)])).toBe(true);
  });
});

describe("checkout's packing choice", () => {
  it("brings Israel Post to a 100×100 canvas in Israel only when rolled", () => {
    const a = canvas(100, 100);
    // 112×112×11 cm boxed: 358 cm length + girth, over Israel Post's 300.
    const boxed = options(a, "IL", false);
    expect(boxed.ok.map((q) => q.method)).not.toContain("ISRAEL_POST");
    expect(boxed.all.find((q) => q.method === "ISRAEL_POST")).toMatchObject({
      mode: "blocked",
      reason: "SIZE_QUOTE",
    });
    expect(boxed.all.every((q) => q.packing === undefined)).toBe(true);
    // Rolled: a 110×26×26 cm tube, 2.7 kg → home delivery ₪73.
    const rolled = options(a, "IL", true);
    expect(rolled.ok.find((q) => q.method === "ISRAEL_POST")).toMatchObject({
      shippingMinor: 7_300,
      packing: "ROLLED",
    });
    expect(rolled.all.every((q) => q.packing === "ROLLED")).toBe(true);
  });

  it("brings Israel Post EMS abroad: Canada ₪171 + 4 × ₪24 for the 3 kg tube", () => {
    const a = canvas(100, 100);
    expect(options(a, "CA", false).ok.map((q) => q.method)).toEqual([
      "CARRIER_TABLE",
    ]);
    const rolled = options(a, "CA", true);
    expect(rolled.ok.find((q) => q.method === "ISRAEL_POST")).toMatchObject({
      shippingMinor: 17_100 + 4 * 2_400,
      packing: "ROLLED",
      israelPost: { service: "EMS", group: 4 },
    });
  });

  it("matches the document's table for a 100×100 canvas (shipping only, ₪)", () => {
    // docs/pricing/shipping-taxes-and-fees.tex, "Stretched or rolled". DHL bills the tube's
    // volume (15 kg) instead of the box's (28 kg); EMS to the US takes at most 200 cm in length
    // plus girth, and this tube is 110 + 104.
    const a = canvas(100, 100);
    const price = (country: string, rolled: boolean) =>
      Object.fromEntries(
        options(a, country, rolled).all.map((q) => [
          q.method,
          q.mode === "ok" ? q.shippingMinor / 100 : null,
        ]),
      );
    expect(price("IL", false)).toMatchObject({
      CARRIER_TABLE: 250,
      ISRAEL_POST: null,
    });
    expect(price("IL", true)).toMatchObject({
      CARRIER_TABLE: 250,
      ISRAEL_POST: 73,
    });
    expect(price("CA", false)).toEqual({
      CARRIER_TABLE: 3396,
      ISRAEL_POST: null,
    });
    expect(price("CA", true)).toEqual({
      CARRIER_TABLE: 2321,
      ISRAEL_POST: 267,
    });
    expect(price("US", false)).toEqual({
      CARRIER_TABLE: 3396,
      ISRAEL_POST: null,
    });
    expect(price("US", true)).toEqual({
      CARRIER_TABLE: 2321,
      ISRAEL_POST: null,
    });
    expect(price("JP", false)).toEqual({
      CARRIER_TABLE: 5825,
      ISRAEL_POST: null,
    });
    expect(price("JP", true)).toEqual({
      CARRIER_TABLE: 3916,
      ISRAEL_POST: 243,
    });
  });

  it("leaves a work the painter keeps stretched as listed", () => {
    const rolled = options(canvas(100, 100, false), "IL", true);
    expect(rolled.ok.map((q) => q.method)).not.toContain("ISRAEL_POST");
    expect(rolled.all.every((q) => q.packing === undefined)).toBe(true);
  });
});

describe('"Delivery from" on the artwork page', () => {
  it("shows the rolled price when it is cheaper, marked rolled", () => {
    const big = spec(canvas(100, 100));
    const z = zoneEstimates(big, settings, DAY);
    expect(z.IL).toEqual({
      fromIlsMinor: 7_300,
      insured: false,
      estimate: DOMESTIC,
      rolled: true,
    });
    // Canada by EMS (the US's 200 cm length + girth is under the tube's 214), plus the minimum EMS
    // insurance.
    expect(z.NORTH_AMERICA).toEqual({
      fromIlsMinor: 17_100 + 4 * 2_400 + 690,
      insured: true,
      estimate: ABROAD,
      rolled: true,
    });
    expect(z.REST_OF_WORLD).toMatchObject({ rolled: true });
    // Kept stretched, the same work only has the courier: over ₪1,000 abroad.
    const kept = zoneEstimates({ ...big, canBeRolled: false }, settings, DAY);
    expect(kept.IL).toEqual({ fromIlsMinor: 25_000, insured: false });
    const na = kept.NORTH_AMERICA;
    expect(typeof na === "object" && na.fromIlsMinor).toBeGreaterThan(100_000);
  });

  it("keeps the stretched price on a tie", () => {
    // 40×50: boxed and rolled both go by Israel Post home delivery at ₪73.
    expect(zoneEstimates(spec(canvas(40, 50)), settings, DAY).IL).toEqual({
      fromIlsMinor: 7_300,
      insured: false,
      estimate: DOMESTIC,
    });
  });
});
