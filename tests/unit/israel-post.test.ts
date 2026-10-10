import { describe, expect, it } from "vitest";
import { COUNTRY_CODES } from "@/lib/countries";
import {
  emsGroupOf,
  emsInsurance,
  israelPostEstimate,
  israelPostLimitOf,
  type PostPieceInput,
} from "@/server/shipping/israel-post";
import { quoteShipping, zoneEstimates } from "@/server/shipping/rates";
import { ISRAEL_POST_2026 as T } from "@/server/shipping/tariff";
import type {
  ArtworkShipSpec,
  FxReference,
  QuoteShippingInput,
  ShippingSettings,
} from "@/server/shipping/types";
import { demoPackaging } from "../../scripts/seed/packaging";
import { shippingDefaults } from "../../scripts/seed/settings";

/**
 * Israel Post at its published prices (`src/server/shipping/israel-post.ts`, the data in
 * `tariff/israel-post-2026.ts`) and the examples of docs/pricing/shipping-taxes-and-fees.tex.
 */
const settings: ShippingSettings = shippingDefaults;
const fx: FxReference = {
  ilsPerUsd: 3.7,
  ilsPerEur: 4.0,
  ilsPerGbp: 4.7,
  asOf: "2026-10-01",
};
const DAY = new Date("2026-10-15T09:00:00Z");

/** A canvas packed by the default rules (painting + 12 cm, 11 cm deep, 1.5 kg + 6 kg/m²). */
function canvasBox(hCm: number, wCm: number): PostPieceInput {
  const p = demoPackaging({
    heightMm: hCm * 10,
    widthMm: wCm * 10,
    surface: "CANVAS",
    canBeRolled: false,
    crate: false,
  });
  return {
    lengthMm: p.packedLengthMm,
    widthMm: p.packedWidthMm,
    heightMm: p.packedHeightMm,
    weightG: p.packedWeightG,
  };
}

function priceOf(pieces: PostPieceInput[], country: string) {
  const r = israelPostEstimate({ pieces, country });
  return r.ok ? r.detail.totalMinor : r.reason;
}

describe("the published prices", () => {
  it("prices home delivery in Israel by weight band (inter-city)", () => {
    expect(T.domestic.bands).toEqual([
      { upToG: 1_000, minor: 6_700 },
      { upToG: 10_000, minor: 7_300 },
      { upToG: 20_000, minor: 8_600 },
    ]);
    const box = (weightG: number) => [
      { lengthMm: 400, widthMm: 300, heightMm: 100, weightG },
    ];
    expect(priceOf(box(900), "IL")).toBe(6_700);
    expect(priceOf(box(1_001), "IL")).toBe(7_300);
    expect(priceOf(box(10_000), "IL")).toBe(7_300);
    expect(priceOf(box(10_001), "IL")).toBe(8_600);
    expect(priceOf(box(20_001), "IL")).toBe("TOO_HEAVY");
  });

  it("prices EMS by group: up to 0.5 kg, up to 1 kg, then each 0.5 kg or part", () => {
    expect(Object.keys(T.ems.groups)).toHaveLength(13);
    expect(T.ems.groups[1]).toEqual({
      upTo500: 17_500,
      upTo1000: 20_600,
      perExtra500: 3_150,
    });
    expect(T.ems.groups[3]).toEqual({
      upTo500: 17_400,
      upTo1000: 18_400,
      perExtra500: 1_150,
    });
    const box = (weightG: number) => [
      { lengthMm: 400, widthMm: 300, heightMm: 100, weightG },
    ];
    expect(priceOf(box(400), "US")).toBe(17_500);
    expect(priceOf(box(1_000), "US")).toBe(20_600);
    expect(priceOf(box(1_001), "US")).toBe(20_600 + 3_150);
    expect(priceOf(box(5_340), "US")).toBe(20_600 + 9 * 3_150);
    expect(priceOf(box(20_001), "US")).toBe("TOO_HEAVY");
  });

  it("puts every country in at most one EMS group and one size limit", () => {
    const served = Object.values(T.ems.countryGroups).flat();
    expect(new Set(served).size).toBe(served.length);
    expect(served).toHaveLength(171);
    expect(served).not.toContain("IL");
    for (const c of served) expect(COUNTRY_CODES, c).toContain(c);
    const limited = T.ems.limits.flatMap((l) => l.countries);
    expect(new Set(limited).size).toBe(limited.length);
    expect([...limited].sort()).toEqual([...served].sort());
    expect(emsGroupOf("US")).toBe(1);
    expect(["GB", "FR", "DE", "IT", "NL", "CH"].map(emsGroupOf)).toEqual([
      3, 3, 3, 3, 3, 3,
    ]);
    expect(emsGroupOf("CA")).toBe(4);
    expect(emsGroupOf("JP")).toBe(5);
    expect(emsGroupOf("SA")).toBeNull();
    expect(israelPostLimitOf("US")).toMatchObject({
      maxSideCm: 105,
      maxLengthGirthCm: 200,
    });
    expect(israelPostLimitOf("GB")).toMatchObject({
      maxSideCm: 150,
      maxLengthGirthCm: 300,
    });
    expect(israelPostLimitOf("IL")).toEqual({
      maxSideCm: 150,
      maxLengthGirthCm: 300,
    });
  });
});

describe("the document's examples", () => {
  it("an 80×80 canvas (92×92×11 cm, 5.34 kg) fits the 300 cm countries, not the US", () => {
    const box = [canvasBox(80, 80)];
    expect(box[0]?.weightG).toBe(5_340);
    // 5.34 kg → 5.5 kg: up to 1 kg + 9 × each further 0.5 kg.
    expect(priceOf(box, "GB")).toBe(18_400 + 9 * 1_150);
    expect(priceOf(box, "CA")).toBe(17_100 + 9 * 2_400);
    expect(priceOf(box, "JP")).toBe(16_100 + 9 * 2_050);
    // 92 + 2 × (92 + 11) = 298 cm: under 300, over the US's 200.
    expect(priceOf(box, "US")).toBe("TOO_LARGE");
    expect(priceOf(box, "IL")).toBe(7_300);
  });

  it("an 80×100 canvas (112×92×11 cm) is too large for Israel Post anywhere", () => {
    const box = [canvasBox(80, 100)];
    expect(priceOf(box, "IL")).toBe("TOO_LARGE");
    expect(priceOf(box, "GB")).toBe("TOO_LARGE");
  });

  it("a 40×60 canvas fits even the US", () => {
    // 72×52×11 cm: 72 + 2 × 63 = 198 cm; 2.94 kg → 3 kg.
    expect(priceOf([canvasBox(40, 60)], "US")).toBe(20_600 + 4 * 3_150);
  });

  it("prices each work as its own parcel", () => {
    const one = priceOf([canvasBox(80, 80)], "IL") as number;
    expect(priceOf([canvasBox(80, 80), canvasBox(80, 80)], "IL")).toBe(2 * one);
  });

  it("insures EMS at ₪6.90 per ₪1,000 or part, up to ₪25,000", () => {
    expect(emsInsurance(320_000)).toEqual({
      valueMinor: 320_000,
      premiumMinor: 4 * 690,
    });
    expect(emsInsurance(5_000_000)).toEqual({
      valueMinor: 2_500_000,
      premiumMinor: 25 * 690,
    });
    expect(emsInsurance(0).premiumMinor).toBe(0);
  });

  it("refuses destinations without EMS", () => {
    expect(priceOf([canvasBox(40, 60)], "SA")).toBe("NOT_SERVED");
  });
});

describe("the ISRAEL_POST method", () => {
  const spec = (over: Partial<ArtworkShipSpec> = {}): ArtworkShipSpec => ({
    artworkId: "a",
    heightMm: 300,
    widthMm: 300,
    depthMm: 10,
    packagingType: "FLAT_BOX",
    canBeRolled: false,
    packedLengthMm: 400,
    packedWidthMm: 400,
    packedHeightMm: 90,
    packedWeightG: 2000,
    sizeClassOverride: null,
    glazing: "NONE",
    framed: false,
    shipsInternationally: true,
    localPickupOnly: false,
    quoteOnly: false,
    maxInsurableValueMinor: null,
    dispatchDays: 5,
    ...over,
  });
  const input = (
    over: Partial<QuoteShippingInput> = {},
  ): QuoteShippingInput => ({
    items: [spec()],
    country: "IL",
    method: "ISRAEL_POST",
    currency: "ILS",
    date: DAY,
    declaredValueIlsMinor: 320_000,
    settings,
    fx,
    carrier: "DHL",
    ...over,
  });

  it("in Israel: home delivery at the published price, by hand, uninsured", () => {
    expect(quoteShipping(input())).toMatchObject({
      mode: "ok",
      method: "ISRAEL_POST",
      carrier: "MANUAL",
      rateSource: "ISRAEL_POST",
      shippingMinor: 7_300,
      insured: false,
      insuranceMinor: 0,
      israelPost: { service: "DOMESTIC_DOOR", group: null, totalMinor: 7_300 },
      estimate: { en: "1–2 business days" },
      notices: [],
    });
  });

  it("abroad: EMS with its insurance, the DAP notices and dollars when asked", () => {
    const q = quoteShipping(input({ country: "US" }));
    expect(q).toMatchObject({
      mode: "ok",
      carrier: "MANUAL",
      rateSource: "ISRAEL_POST",
      // 2 kg: ₪206 + 2 × ₪31.50
      shippingMinor: 26_900,
      insured: true,
      insuredValueMinor: 320_000,
      insuranceMinor: 4 * 690,
      israelPost: { service: "EMS", group: 1 },
      estimate: { en: "5–10 business days" },
    });
    expect(q.notices).toContain("DAP_DUTIES");
    expect(q.notices).toContain("TRANSIT_ESTIMATE");
    const usd = quoteShipping(input({ country: "US", currency: "USD" }));
    // ₪269 → $72.70 → $73; ₪27.60 → $7.46 → $8.
    expect(usd.shippingMinor).toBe(7_300);
    expect(usd.insuranceMinor).toBe(800);
  });

  it("is not offered for crates, glazing, oversized parcels, unserved or switched-off destinations", () => {
    const refused = (over: Partial<QuoteShippingInput>) => {
      const q = quoteShipping(input(over));
      return `${q.mode}:${q.reason}`;
    };
    expect(refused({ items: [spec({ packagingType: "CRATE" })] })).toBe(
      "blocked:SIZE_QUOTE",
    );
    expect(refused({ items: [spec({ glazing: "GLASS" })] })).toBe(
      "blocked:SIZE_QUOTE",
    );
    expect(
      refused({
        items: [
          spec({
            packedLengthMm: 1120,
            packedWidthMm: 920,
            packedHeightMm: 110,
            packedWeightG: 6300,
          }),
        ],
      }),
    ).toBe("blocked:SIZE_QUOTE");
    expect(refused({ country: "SA" })).toBe("blocked:ZONE_DISABLED");
    // Europe is disabled in the seed (spec §1.3): a quote, as for the courier.
    expect(refused({ country: "GB" })).toBe("quote_only:ZONE_DISABLED");
    const off: ShippingSettings = {
      ...settings,
      israelPost: { ...settings.israelPost, domestic: false },
    };
    expect(refused({ settings: off })).toBe("blocked:ZONE_DISABLED");
  });

  it('makes Israel the cheaper "Delivery from" when the parcel fits', () => {
    const p = demoPackaging({
      heightMm: 600,
      widthMm: 800,
      surface: "CANVAS",
      canBeRolled: false,
      crate: false,
    });
    const work = spec({
      heightMm: 600,
      widthMm: 800,
      packagingType: p.packagingType,
      packedLengthMm: p.packedLengthMm,
      packedWidthMm: p.packedWidthMm,
      packedHeightMm: p.packedHeightMm,
      packedWeightG: p.packedWeightG,
    });
    // The table's M class costs ₪120; Israel Post home delivery ₪73, with its own delivery time.
    expect(zoneEstimates(work, settings, DAY).IL).toEqual({
      fromIlsMinor: 7_300,
      insured: false,
      estimate: { he: "1–2 ימי עסקים", en: "1–2 business days" },
    });
  });
});
