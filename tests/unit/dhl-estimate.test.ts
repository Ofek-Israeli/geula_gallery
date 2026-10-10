import { describe, expect, it } from "vitest";
import type { DhlEstimateSettings } from "@/server/settings/schemas";
import {
  type DhlPieceInput,
  dhlEstimate,
  dhlTransportMinor,
  FUEL_STALE_AFTER_DAYS,
  fuelSurchargeStale,
  tariffReviewDue,
} from "@/server/shipping/dhl-estimate";
import { demoPackaging } from "../../scripts/seed/packaging";
import { shippingDefaults } from "../../scripts/seed/settings";

/**
 * The DHL Express estimate abroad (`src/server/shipping/dhl-estimate.ts`) and the worked examples
 * of docs/pricing/shipping-taxes-and-fees.tex: if the tariff, a setting or a rule changes, this
 * test and the document change together.
 */
const settings: DhlEstimateSettings = shippingDefaults.dhlEstimate;
const OCT_15 = new Date("2026-10-15T09:00:00Z");
const MAR_1 = new Date("2027-03-01T09:00:00Z");

/** The document's box: a 100×80 cm canvas packed 112×92×11 cm, 6.3 kg. */
const canvas: DhlPieceInput = {
  lengthMm: 1120,
  widthMm: 920,
  heightMm: 110,
  weightG: 6300,
  nonConveyablePackaging: false,
};

function estimate(
  over: Partial<Parameters<typeof dhlEstimate>[0]> = {},
): ReturnType<typeof dhlEstimate> {
  return dhlEstimate({
    pieces: [canvas],
    country: "US",
    date: OCT_15,
    settings,
    exportDeclaration: true,
    ...over,
  });
}

function detail(over: Partial<Parameters<typeof dhlEstimate>[0]> = {}) {
  const r = estimate(over);
  if (!r.ok) throw new Error(`no estimate: ${r.reason}`);
  return r.detail;
}

describe("the document's settings", () => {
  it("uses DHL's fuel surcharge for 12–18 Oct 2026, list prices and DHL's export declaration", () => {
    expect(settings).toEqual({
      enabled: true,
      fuelSurchargePct: 49,
      fuelSurchargeAsOf: "2026-10-12",
      accountDiscountPct: 0,
      exportDeclarationByDhl: true,
    });
    expect(shippingDefaults.insurance).toMatchObject({
      ratePct: 1,
      minIls: 45,
      maxInsuredIls: 10_000,
    });
  });
});

describe("worked examples (a)–(e)", () => {
  it("(a) one canvas to the US on 15 Oct 2026: ₪2,959", () => {
    expect(detail()).toEqual({
      tariff: "DHL-EXPRESS-WORLDWIDE-IL-2026",
      zone: 1,
      region: "AMERICAS",
      pieces: [
        {
          dimsCm: [112, 92, 11],
          actualG: 6300,
          volumetricG: 22_669,
          billingG: 23_000,
          surcharge: "OVERSIZE",
          surchargeMinor: 8000,
        },
      ],
      billingG: 23_000,
      transportMinor: 177_930,
      discountBp: 0,
      transportNetMinor: 177_930,
      pieceSurchargesMinor: 8000,
      demandPerKgMinor: 170,
      demandMinor: 3910,
      elevatedRiskMinor: 0,
      restrictedMinor: 0,
      fuelBp: 4900,
      fuelAsOf: "2026-10-12",
      // 49 % of 1,779.30 + 80 + 39.10 = 1,898.40 → 930.216 → 930.22
      fuelMinor: 93_022,
      // 110 + 18 % VAT
      exportDeclarationMinor: 12_980,
      // 2,958.42 → 2,959
      roundingMinor: 58,
      totalMinor: 295_900,
    });
  });

  it("(b) Germany: ₪3,689, (c) Japan: ₪5,098", () => {
    expect(detail({ country: "DE" })).toMatchObject({
      zone: 2,
      region: "EUROPE",
      transportMinor: 228_795,
      demandMinor: 2070,
      fuelMinor: 117_044,
      totalMinor: 368_900,
    });
    expect(detail({ country: "JP" })).toMatchObject({
      zone: 4,
      region: "ASIA",
      transportMinor: 325_381,
      demandMinor: 0,
      fuelMinor: 163_357,
      totalMinor: 509_800,
    });
  });

  it("(d) two canvases in one shipment: 46 kg, ₪5,414 (less than two shipments)", () => {
    const d = detail({ pieces: [canvas, canvas] });
    expect(d).toMatchObject({
      billingG: 46_000,
      // 30 kg row + 16 × 70.61
      transportMinor: 217_830 + 16 * 7061,
      pieceSurchargesMinor: 16_000,
      demandMinor: 7820,
      fuelMinor: 173_767,
      exportDeclarationMinor: 12_980,
      totalMinor: 541_400,
    });
    expect(d.totalMinor).toBeLessThan(2 * 295_900);
  });

  it("(e) the same as (a) after the peak season: ₪2,901", () => {
    expect(detail({ date: MAR_1 })).toMatchObject({
      demandPerKgMinor: 0,
      demandMinor: 0,
      fuelMinor: 91_106,
      totalMinor: 290_100,
    });
  });
});

describe("the document's price table (painting + 12 cm per side, 11 cm deep)", () => {
  const table: [number, number, number, [number, number, number, number]][] = [
    [600, 800, 15_000, [2201, 2617, 3797, 5148]],
    [800, 1000, 23_000, [2959, 3689, 5098, 7284]],
    [1000, 1200, 33_000, [3894, 4877, 6604, 9629]],
    [1200, 1450, 46_000, [5295, 6369, 8716, 12_790]],
  ];
  it.each(table)("%i×%i mm: %i g billed", (h, w, billingG, totals) => {
    const p = demoPackaging({
      heightMm: h,
      widthMm: w,
      surface: "CANVAS",
      canBeRolled: false,
      crate: false,
    });
    const piece: DhlPieceInput = {
      lengthMm: p.packedLengthMm,
      widthMm: p.packedWidthMm,
      heightMm: p.packedHeightMm,
      weightG: p.packedWeightG,
      nonConveyablePackaging: false,
    };
    const got = ["US", "DE", "JP", "ZA"].map((country) => {
      const d = detail({ pieces: [piece], country });
      expect(d.billingG).toBe(billingG);
      return d.totalMinor / 100;
    });
    expect(got).toEqual(totals);
  });
});

describe("the document's comparison with Israel Post (an 80×80 canvas)", () => {
  it("costs ₪3,209 to the UK, ₪2,621 to Canada and the US, ₪4,512 to Japan by DHL", () => {
    const p = demoPackaging({
      heightMm: 800,
      widthMm: 800,
      surface: "CANVAS",
      canBeRolled: false,
      crate: false,
    });
    const piece: DhlPieceInput = {
      lengthMm: p.packedLengthMm,
      widthMm: p.packedWidthMm,
      heightMm: p.packedHeightMm,
      weightG: p.packedWeightG,
      nonConveyablePackaging: false,
    };
    const totals = ["GB", "CA", "US", "JP"].map(
      (country) => detail({ pieces: [piece], country }).totalMinor / 100,
    );
    expect(totals).toEqual([3209, 2621, 2621, 4512]);
  });
});

describe("billing weight and transport", () => {
  it("rounds each piece up to 0.5 kg and a shipment above 30 kg up to whole kg", () => {
    const thirty: DhlPieceInput = {
      lengthMm: 400,
      widthMm: 300,
      heightMm: 200,
      weightG: 30_000,
      nonConveyablePackaging: false,
    };
    const half: DhlPieceInput = { ...thirty, weightG: 100 };
    // 24,000 cm³ → 4.8 kg volumetric → 5.0 kg; 30 kg actual → 30 kg.
    const d = detail({ pieces: [thirty, half] });
    expect(d.pieces.map((p) => p.billingG)).toEqual([30_000, 5000]);
    expect(d.billingG).toBe(35_000);
    expect(d.transportMinor).toBe(217_830 + 5 * 7061);
    // 30 kg + 0.5 kg = 30.5 kg → 31 kg.
    const small = detail({
      pieces: [thirty, { ...half, lengthMm: 100, widthMm: 100, heightMm: 50 }],
    });
    expect(small.billingG).toBe(31_000);
  });

  it("measures sides in whole cm rounded up, as the label does", () => {
    const d = detail({
      pieces: [{ ...canvas, lengthMm: 1001, widthMm: 501, heightMm: 101 }],
    });
    expect(d.pieces[0]?.dimsCm).toEqual([101, 51, 11]);
    expect(d.pieces[0]?.surcharge).toBe("OVERSIZE");
  });

  it("adds the published half-kilo increment between whole kilos", () => {
    expect(dhlTransportMinor(1, 10_500, OCT_15)).toBe(112_070 + 2438);
    expect(dhlTransportMinor(1, 20_500, OCT_15)).toBe(160_830 + 2850);
    expect(dhlTransportMinor(6, 75_000, OCT_15)).toBe(1_213_767 + 5 * 16_875);
  });
});

describe("surcharges", () => {
  const box = (over: Partial<DhlPieceInput>): DhlPieceInput => ({
    lengthMm: 500,
    widthMm: 400,
    heightMm: 300,
    weightG: 5000,
    nonConveyablePackaging: false,
    ...over,
  });
  const surchargeOf = (p: DhlPieceInput) => detail({ pieces: [p] }).pieces[0];

  it("applies one piece surcharge: Overweight, else Oversize, else Non-Conveyable", () => {
    expect(surchargeOf(box({ weightG: 71_000 }))).toMatchObject({
      surcharge: "OVERWEIGHT",
      surchargeMinor: 39_500,
    });
    // 150 × 100 × 50 cm = 150 kg volumetric.
    expect(
      surchargeOf(box({ lengthMm: 1500, widthMm: 1000, heightMm: 500 }))
        ?.surcharge,
    ).toBe("OVERWEIGHT");
    expect(
      surchargeOf(box({ lengthMm: 1200, weightG: 30_000 }))?.surcharge,
    ).toBe("OVERSIZE");
    expect(surchargeOf(box({ weightG: 30_000 }))).toMatchObject({
      surcharge: "NON_CONVEYABLE",
      surchargeMinor: 8000,
    });
    expect(surchargeOf(box({ nonConveyablePackaging: true }))?.surcharge).toBe(
      "NON_CONVEYABLE",
    );
    expect(surchargeOf(box({}))).toMatchObject({
      surcharge: null,
      surchargeMinor: 0,
    });
  });

  it("charges the demand surcharge on inclusive Jerusalem days", () => {
    const demand = (iso: string) =>
      detail({ date: new Date(iso) }).demandPerKgMinor;
    expect(demand("2026-09-30T20:59:00Z")).toBe(0);
    expect(demand("2026-09-30T21:00:00Z")).toBe(170);
    expect(demand("2027-02-05T21:59:00Z")).toBe(170);
    expect(demand("2027-02-05T22:00:00Z")).toBe(0);
  });

  it("puts Elevated Risk inside the fuel base and Restricted Destination outside", () => {
    // Libya: zone 6, demand "Rest of the World", restricted and elevated risk.
    const ly = detail({ country: "LY" });
    expect(ly).toMatchObject({
      zone: 6,
      region: "ROW",
      demandPerKgMinor: 280,
      elevatedRiskMinor: 11_900,
      restrictedMinor: 11_900,
    });
    expect(ly.fuelMinor).toBe(
      Math.round(
        (ly.transportNetMinor +
          ly.pieceSurchargesMinor +
          ly.demandMinor +
          ly.elevatedRiskMinor) *
          0.49,
      ),
    );
    const ua = detail({ country: "UA" });
    expect(ua).toMatchObject({
      zone: 2,
      region: "ROW",
      elevatedRiskMinor: 11_900,
      restrictedMinor: 0,
    });
    expect(detail({ country: "GB" }).elevatedRiskMinor).toBe(0);
  });

  it("takes the account discount off transport only", () => {
    const d = detail({ settings: { ...settings, accountDiscountPct: 30 } });
    expect(d.discountBp).toBe(3000);
    expect(d.transportNetMinor).toBe(177_930 - 53_379);
    expect(d.pieceSurchargesMinor).toBe(8000);
    expect(d.fuelMinor).toBe(
      Math.round((d.transportNetMinor + 8000 + 3910) * 0.49),
    );
  });

  it("adds the export declaration only when it is due and DHL files it", () => {
    expect(detail({ exportDeclaration: false }).exportDeclarationMinor).toBe(0);
    expect(
      detail({ settings: { ...settings, exportDeclarationByDhl: false } })
        .exportDeclarationMinor,
    ).toBe(0);
  });
});

describe("when there is no estimate", () => {
  it("reports why", () => {
    const reason = (over: Partial<Parameters<typeof dhlEstimate>[0]>) => {
      const r = estimate(over);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason({ settings: { ...settings, enabled: false } })).toBe(
      "DISABLED",
    );
    expect(reason({ country: "AF" })).toBe("NO_DHL_ZONE");
    expect(reason({ country: "IL" })).toBe("NO_DHL_ZONE");
    expect(reason({ pieces: [] })).toBe("NO_PIECES");
    expect(reason({ pieces: [{ ...canvas, lengthMm: 3010 }] })).toBe(
      "PIECE_LIMIT",
    );
    const heavy = { ...canvas, weightG: 999_000 };
    expect(reason({ pieces: [heavy, heavy, heavy, heavy] })).toBe(
      "SHIPMENT_LIMIT",
    );
  });
});

describe("keeping the estimate current", () => {
  it(`flags a fuel surcharge older than ${FUEL_STALE_AFTER_DAYS} days`, () => {
    expect(
      fuelSurchargeStale("2026-10-12", new Date("2026-10-26T09:00:00Z")),
    ).toBe(false);
    expect(
      fuelSurchargeStale("2026-10-12", new Date("2026-10-27T09:00:00Z")),
    ).toBe(true);
  });

  it("flags the yearly guide from its review date", () => {
    expect(tariffReviewDue(new Date("2026-12-31T12:00:00Z"))).toBe(false);
    expect(tariffReviewDue(new Date("2026-12-31T23:00:00Z"))).toBe(true);
  });
});
