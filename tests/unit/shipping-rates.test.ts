import { describe, expect, it } from "vitest";
import {
  activeSurcharges,
  classify,
  insuredValueMinor,
  quoteShipping,
  rolledTubeBox,
  zoneEstimates,
} from "@/server/shipping/rates";
import type {
  ArtworkShipSpec,
  FxReference,
  QuoteShippingInput,
  ShippingSettings,
} from "@/server/shipping/types";
import { demoPackaging } from "../../scripts/seed/packaging";
import { shippingDefaults } from "../../scripts/seed/settings";

const fx: FxReference = {
  ilsPerUsd: 3.7,
  ilsPerEur: 4.0,
  ilsPerGbp: 4.7,
  asOf: "2026-10-01",
};
const settings: ShippingSettings = shippingDefaults;
/** 2026-10-01 12:00 in Jerusalem (inside the DHL Demand window). */
const DAY = new Date("2026-10-01T09:00:00Z");

function spec(over: Partial<ArtworkShipSpec> = {}): ArtworkShipSpec {
  return {
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
  };
}

/** A work from the demo manifest table, packed by the §8.3 defaults. */
function demo(
  heightMm: number,
  widthMm: number,
  surface: "CANVAS" | "BOARD" | "CARDBOARD" | "PAPER",
  opts: { canBeRolled?: boolean; crate?: boolean; quoteOnly?: boolean } = {},
): ArtworkShipSpec {
  const p = demoPackaging({
    heightMm,
    widthMm,
    surface,
    canBeRolled: opts.canBeRolled ?? false,
    crate: opts.crate ?? false,
  });
  return spec({
    heightMm,
    widthMm,
    depthMm: p.depthMm,
    packagingType: p.packagingType,
    canBeRolled: opts.canBeRolled ?? false,
    packedLengthMm: p.packedLengthMm,
    packedWidthMm: p.packedWidthMm,
    packedHeightMm: p.packedHeightMm,
    packedWeightG: p.packedWeightG,
    quoteOnly: opts.quoteOnly ?? false,
  });
}

function input(over: Partial<QuoteShippingInput> = {}): QuoteShippingInput {
  return {
    items: [spec()],
    country: "IL",
    currency: "ILS",
    date: DAY,
    declaredValueIlsMinor: 320_000,
    settings,
    fx,
    carrier: "DHL",
    ...over,
  };
}

const volumetricKg = (a: ArtworkShipSpec) => {
  const box =
    a.packagingType === "ROLLED_TUBE"
      ? rolledTubeBox(a)
      : {
          lengthMm: a.packedLengthMm,
          widthMm: a.packedWidthMm,
          heightMm: a.packedHeightMm,
        };
  return ((box.lengthMm * box.widthMm * box.heightMm) / 1000 / 5000).toFixed(2);
};

describe("§8.3 expected-class table (exact numbers)", () => {
  it("landscape-no-26: 425×425×90, 2,058 g, 3.25 kg → S", () => {
    const a = demo(305, 305, "CARDBOARD");
    expect([a.packedLengthMm, a.packedWidthMm, a.packedHeightMm]).toEqual([
      425, 425, 90,
    ]);
    expect(a.packedWeightG).toBe(2058);
    expect(volumetricKg(a)).toBe("3.25");
    expect(classify(a).sizeClass).toBe("S");
  });

  it("antibes: 500×397×82, 2,299 g, 3.26 kg → S (longest exactly 50.0 cm)", () => {
    const a = demo(420, 317, "PAPER");
    expect([a.packedLengthMm, a.packedWidthMm, a.packedHeightMm]).toEqual([
      500, 397, 82,
    ]);
    expect(a.packedWeightG).toBe(2299);
    expect(volumetricKg(a)).toBe("3.26");
    expect(classify(a).sizeClass).toBe("S");
  });

  it("a-holiday: 1138×884×110, 6,167 g, 22.13 kg → L (oversize)", () => {
    const a = demo(764, 1018, "CANVAS");
    expect([a.packedLengthMm, a.packedWidthMm, a.packedHeightMm]).toEqual([
      884, 1138, 110,
    ]);
    expect(a.packedWeightG).toBe(6167);
    expect(volumetricKg(a)).toBe("22.13");
    const c = classify(a);
    expect(c.sizeClass).toBe("L");
    expect(c.oversizePiece).toBe(true);
    expect(c.chargeableG).toBe(22132);
  });

  it("icebound (tube): 742×260×260, 4,451 g, 10.03 kg → M", () => {
    const a = demo(642, 766, "CANVAS", { canBeRolled: true });
    expect(a.packagingType).toBe("ROLLED_TUBE");
    expect([a.packedLengthMm, a.packedWidthMm, a.packedHeightMm]).toEqual([
      742, 260, 260,
    ]);
    expect(a.packedWeightG).toBe(4451);
    expect(volumetricKg(a)).toBe("10.03");
    expect(classify(a).sizeClass).toBe("M");
  });

  it("banks-of-the-durance: crate → QUOTE", () => {
    const a = demo(620, 1480, "CANVAS", { crate: true, quoteOnly: true });
    expect(a.packagingType).toBe("CRATE");
    const c = classify(a);
    expect(c.sizeClass).toBe("QUOTE");
    expect(c.reasons).toEqual(expect.arrayContaining(["CRATE", "QUOTE_ONLY"]));
  });
});

describe("classify", () => {
  it("applies the S/M/L boundaries on sorted packed dimensions", () => {
    const box = (l: number, w: number, h: number, g = 1000) =>
      classify(
        spec({
          packedLengthMm: l,
          packedWidthMm: w,
          packedHeightMm: h,
          packedWeightG: g,
        }),
      ).sizeClass;
    expect(box(500, 300, 50)).toBe("S");
    expect(box(50, 300, 501)).toBe("M"); // sorted: longest 501
    expect(box(400, 400, 50, 5000)).toBe("S");
    expect(box(400, 400, 50, 5001)).toBe("M");
    expect(box(1000, 800, 50, 20_000)).toBe("M");
    expect(box(1001, 500, 50)).toBe("L");
    expect(box(900, 801, 50)).toBe("L");
    expect(box(900, 700, 50, 20_001)).toBe("L");
    expect(box(900, 700, 50, 45_000 - 1)).toBe("QUOTE"); // ≥ 25 kg actual
  });

  it("uses chargeable weight with the divisor", () => {
    // 60×60×60 cm = 216,000 cm³ → 43.2 kg at 5000, 54 kg at 4000.
    const a = spec({
      packedLengthMm: 600,
      packedWidthMm: 600,
      packedHeightMm: 600,
      packedWeightG: 3000,
    });
    expect(classify(a).chargeableG).toBe(43_200);
    expect(classify(a).sizeClass).toBe("L");
    expect(classify(a, 4000).chargeableG).toBe(54_000);
    expect(classify(a, 4000).sizeClass).toBe("QUOTE");
  });

  it("sends crates, glazing and heavy works to QUOTE", () => {
    expect(classify(spec({ packagingType: "CRATE" })).sizeClass).toBe("QUOTE");
    expect(classify(spec({ glazing: "GLASS" })).sizeClass).toBe("QUOTE");
    expect(classify(spec({ packedWeightG: 25_000 })).sizeClass).toBe("QUOTE");
    expect(classify(spec({ quoteOnly: true })).sizeClass).toBe("QUOTE");
  });

  it("lets an override win, but never above 70 kg or over quote_only", () => {
    const big = spec({
      packedLengthMm: 1200,
      packedWidthMm: 900,
      packedHeightMm: 100,
      packedWeightG: 6000,
    });
    expect(classify(big).sizeClass).toBe("L");
    const overridden = classify({ ...big, sizeClassOverride: "M" });
    expect(overridden.sizeClass).toBe("M");
    expect(overridden.oversizePiece).toBe(true);
    expect(
      classify(spec({ packagingType: "CRATE", sizeClassOverride: "L" }))
        .sizeClass,
    ).toBe("L");
    const heavy = classify(
      spec({ packedWeightG: 30_000, sizeClassOverride: "L" }),
    );
    expect(heavy.sizeClass).toBe("L");
    expect(heavy.nonConveyable).toBe(true);
    expect(
      classify(spec({ packedWeightG: 70_001, sizeClassOverride: "L" }))
        .sizeClass,
    ).toBe("QUOTE");
    expect(
      classify(spec({ quoteOnly: true, sizeClassOverride: "S" })).sizeClass,
    ).toBe("QUOTE");
  });

  it("computes the rolled tube and refuses tubes for works that cannot be rolled", () => {
    expect(rolledTubeBox({ heightMm: 642, widthMm: 766 })).toEqual({
      lengthMm: 742,
      widthMm: 260,
      heightMm: 260,
    });
    const tube = spec({
      heightMm: 1100,
      widthMm: 1400,
      packagingType: "ROLLED_TUBE",
      canBeRolled: true,
      packedWeightG: 4000,
    });
    // 1200 mm tube: oversize above 100 cm → L.
    expect(classify(tube).sizeClass).toBe("L");
    const c = classify({ ...tube, canBeRolled: false });
    expect(c.sizeClass).toBe("QUOTE");
    expect(c.reasons).toContain("NOT_ROLLABLE");
  });
});

describe("surcharges", () => {
  it("windows are inclusive Jerusalem calendar days", () => {
    const ids = (d: string) =>
      activeSurcharges(settings, "NORTH_AMERICA", new Date(d)).map((s) => s.id);
    expect(ids("2026-10-01T09:00:00Z")).toEqual(["fuel", "dhl-demand"]);
    // 2026-09-30 23:30 UTC is already 2026-10-01 in Jerusalem.
    expect(ids("2026-09-30T23:30:00Z")).toEqual(["fuel", "dhl-demand"]);
    expect(ids("2026-09-30T12:00:00Z")).toEqual(["fuel"]);
    expect(ids("2027-02-05T20:00:00Z")).toEqual(["fuel", "dhl-demand"]);
    expect(ids("2027-02-05T23:00:00Z")).toEqual(["fuel"]); // 2027-02-06 in Jerusalem
    expect(ids("2027-02-06T09:00:00Z")).toEqual(["fuel"]);
    expect(activeSurcharges(settings, "IL", DAY)).toEqual([]);
  });
});

describe("quoteShipping", () => {
  it("IL: manual courier, class rate, no surcharges, uninsured", () => {
    const q = quoteShipping(input());
    expect(q).toMatchObject({
      mode: "ok",
      zone: "IL",
      method: "CARRIER_TABLE",
      carrier: "MANUAL",
      sizeClass: "S",
      currency: "ILS",
      shippingMinor: 6000,
      insuranceMinor: 0,
      insured: false,
      insuredValueMinor: 0,
      notices: [],
    });
  });

  it("refuses USD for Israeli destinations", () => {
    expect(() => quoteShipping(input({ currency: "USD" }))).toThrow(RangeError);
  });

  it("abroad: base + fuel % + fixed demand surcharge + capped insurance", () => {
    // The mock carrier has no value cap (DHL's USD 2,500 would route ₪12,500 to a quote).
    const q = quoteShipping(
      input({
        country: "CA",
        carrier: "MOCK",
        declaredValueIlsMinor: 1_250_000,
      }),
    );
    expect(q.mode).toBe("ok");
    expect(q.breakdown).toEqual({
      baseMinor: 26_000,
      pieceFeesMinor: 0,
      surchargesMinor: 5200 + 4000,
    });
    expect(q.shippingMinor).toBe(35_200);
    // ₪12,500 capped at ₪10,000 before the premium: 1.5 % = ₪150.
    expect(q.insured).toBe(true);
    expect(q.insuredValueMinor).toBe(1_000_000);
    expect(q.insuranceMinor).toBe(15_000);
    expect(q.notices).toEqual(["DAP_DUTIES", "TRANSIT_ESTIMATE"]);
    expect(q.estimate?.en).toBe("5–10 business days");
  });

  it("caps the insured value by the artwork cap and applies the minimum premium", () => {
    expect(
      insuredValueMinor(
        1_000_000,
        [spec({ maxInsurableValueMinor: 500_000 })],
        settings,
      ),
    ).toBe(500_000);
    const capped = quoteShipping(
      input({
        country: "CA",
        items: [spec({ maxInsurableValueMinor: 500_000 })],
        declaredValueIlsMinor: 1_000_000,
        carrier: "MOCK",
      }),
    );
    expect(capped.insuranceMinor).toBe(7500);
    const low = quoteShipping(
      input({ country: "CA", declaredValueIlsMinor: 200_000 }),
    );
    expect(low.insuranceMinor).toBe(5000); // 1.5 % = ₪30 < ₪50 minimum
  });

  it("is uninsured when insurance is disabled, for pickup and for the manual carrier", () => {
    const off = {
      ...settings,
      insurance: { ...settings.insurance, enabled: false },
    };
    for (const q of [
      quoteShipping(input({ country: "CA", settings: off })),
      quoteShipping(input({ country: "CA", carrier: "MANUAL" })),
      quoteShipping(input({ method: "LOCAL_PICKUP" })),
      quoteShipping(input({ method: "ARTIST_DELIVERY" })),
    ]) {
      expect(q.insured).toBe(false);
      expect(q.insuranceMinor).toBe(0);
    }
    expect(
      quoteShipping(input({ country: "CA", carrier: "MOCK" })).insured,
    ).toBe(true);
  });

  it("locks USD: shipping and insurance each rounded up to whole dollars", () => {
    const q = quoteShipping(
      input({ country: "US", currency: "USD", declaredValueIlsMinor: 320_000 }),
    );
    // ₪260 + ₪52 + ₪40 = ₪352 → $95.14 → $96; insurance ₪50 → $13.52 → $14.
    expect(q.shippingMinor).toBe(9600);
    expect(q.insuranceMinor).toBe(1400);
    expect(q.fxIlsPerUsd).toBe(3.7);
    expect(q.breakdown.baseMinor).toBe(26_000);
  });

  it("adds the oversize fee only when an oversize piece is overridden below L", () => {
    const big = spec({
      packedLengthMm: 1200,
      packedWidthMm: 900,
      packedHeightMm: 100,
      packedWeightG: 6000,
    });
    expect(quoteShipping(input({ items: [big] })).shippingMinor).toBe(25_000);
    const m = quoteShipping(
      input({ items: [{ ...big, sizeClassOverride: "M" }] }),
    );
    expect(m.sizeClass).toBe("M");
    expect(m.breakdown.pieceFeesMinor).toBe(15_000);
    expect(m.shippingMinor).toBe(12_000 + 15_000);
  });

  it("pickup and artist delivery are Israel-only flat fees", () => {
    expect(quoteShipping(input({ method: "LOCAL_PICKUP" }))).toMatchObject({
      mode: "ok",
      shippingMinor: 0,
      carrier: null,
    });
    expect(
      quoteShipping(input({ method: "ARTIST_DELIVERY" })).shippingMinor,
    ).toBe(15_000);
    expect(
      quoteShipping(
        input({ method: "LOCAL_PICKUP", country: "US", currency: "USD" }),
      ),
    ).toMatchObject({ mode: "blocked", reason: "ZONE_DISABLED" });
  });

  it("routes quote-only works, QUOTE classes and link orders to a quote", () => {
    expect(
      quoteShipping(input({ items: [spec({ packagingType: "CRATE" })] })),
    ).toMatchObject({ mode: "quote_only", reason: "SIZE_QUOTE" });
    expect(
      quoteShipping(input({ items: [spec({ quoteOnly: true })] })),
    ).toMatchObject({ mode: "quote_only", reason: "QUOTE_ONLY" });
    expect(quoteShipping(input({ method: "QUOTED" }))).toMatchObject({
      mode: "quote_only",
      shippingMinor: 0,
    });
  });

  it("blocks works that do not ship internationally (NOT_INTERNATIONAL)", () => {
    expect(
      quoteShipping(
        input({
          country: "CA",
          items: [spec({ shipsInternationally: false })],
        }),
      ),
    ).toMatchObject({ mode: "blocked", reason: "NOT_INTERNATIONAL" });
    expect(
      quoteShipping(
        input({ country: "CA", items: [spec({ localPickupOnly: true })] }),
      ),
    ).toMatchObject({ mode: "blocked", reason: "NOT_INTERNATIONAL" });
    expect(
      quoteShipping(input({ items: [spec({ shipsInternationally: false })] }))
        .mode,
    ).toBe("ok");
  });

  it("sums several pieces", () => {
    const q = quoteShipping(
      input({ items: [spec(), spec({ artworkId: "b" })] }),
    );
    expect(q.shippingMinor).toBe(12_000);
  });
});

describe("zoneEstimates", () => {
  it("prices every zone for a small work", () => {
    const a = demo(305, 305, "CARDBOARD");
    expect(zoneEstimates(a, settings, DAY)).toEqual({
      IL: { fromIlsMinor: 6000, insured: false },
      EUROPE: "QUOTE",
      NORTH_AMERICA: {
        fromIlsMinor: 26_000 + 5200 + 4000 + 5000,
        insured: true,
      },
      REST_OF_WORLD: {
        fromIlsMinor: 30_000 + 6000 + 4000 + 5000,
        insured: true,
      },
    });
  });

  it("returns QUOTE for crates and UNAVAILABLE where the work cannot go", () => {
    const crate = demo(620, 1480, "CANVAS", { crate: true, quoteOnly: true });
    expect(Object.values(zoneEstimates(crate, settings, DAY))).toEqual([
      "QUOTE",
      "QUOTE",
      "QUOTE",
      "QUOTE",
    ]);
    const local = zoneEstimates(
      spec({ shipsInternationally: false }),
      settings,
      DAY,
    );
    expect(local.IL).toEqual({ fromIlsMinor: 6000, insured: false });
    expect(local.NORTH_AMERICA).toBe("UNAVAILABLE");
  });
});
