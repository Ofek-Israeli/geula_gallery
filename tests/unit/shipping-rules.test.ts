import { describe, expect, it } from "vitest";
import { quoteShipping } from "@/server/shipping/rates";
import {
  evaluateDestination,
  nonLatinAddressFields,
} from "@/server/shipping/rules";
import type {
  ArtworkShipSpec,
  CarrierCode,
  FxReference,
  ShippingSettings,
} from "@/server/shipping/types";
import { readDemoManifest } from "../../scripts/lib/demo-manifest";
import { demoPackaging } from "../../scripts/seed/packaging";
import { shippingDefaults } from "../../scripts/seed/settings";

const fx: FxReference = {
  ilsPerUsd: 3.7,
  ilsPerEur: 4.0,
  ilsPerGbp: 4.7,
  asOf: "2026-10-01",
};
const settings: ShippingSettings = shippingDefaults;
const europeOn: ShippingSettings = {
  ...settings,
  zones: settings.zones.map((z) =>
    z.id === "EUROPE" ? { ...z, enabled: true } : z,
  ),
};

const evaluate = (
  country: string,
  ils: number,
  s: ShippingSettings = settings,
  carrier: CarrierCode = "DHL",
) =>
  evaluateDestination({
    country,
    declaredValueIlsMinor: ils * 100,
    carrier,
    settings: s,
    fx,
  });

describe("evaluateDestination", () => {
  it("blocks the deny list; IQ can be removed by the painter", () => {
    for (const c of ["IR", "SY", "LB", "IQ"]) {
      expect(evaluate(c, 1000)).toEqual({
        mode: "blocked",
        reason: "DESTINATION_DENIED",
        notices: [],
      });
    }
    const withoutIq = {
      ...settings,
      deniedCountries: settings.deniedCountries.filter((c) => c !== "IQ"),
    };
    expect(evaluate("IQ", 1000, withoutIq).mode).toBe("ok");
    expect(evaluate("IR", 1000, withoutIq).mode).toBe("blocked");
  });

  it("Israel is always ok without notices", () => {
    expect(evaluate("IL", 50_000)).toEqual({ mode: "ok", notices: [] });
  });

  it("a disabled zone routes to a quote (ZONE_DISABLED)", () => {
    expect(evaluate("DE", 3200)).toMatchObject({
      mode: "quote_only",
      reason: "ZONE_DISABLED",
    });
    expect(evaluate("DE", 3200, europeOn).mode).toBe("ok");
  });

  it("GB at or under GBP 135 is blocked (GB_LOW_VALUE), before the zone check", () => {
    // GBP 135 × 4.7 = ₪634.50
    expect(evaluate("GB", 634.5)).toMatchObject({
      mode: "blocked",
      reason: "GB_LOW_VALUE",
    });
    expect(evaluate("GB", 634.51, europeOn).mode).toBe("ok");
    expect(evaluate("GB", 634.51).reason).toBe("ZONE_DISABLED");
  });

  it("EU low-value notice at or under EUR 150", () => {
    // EUR 150 × 4.0 = ₪600
    expect(evaluate("FR", 600, europeOn).notices).toEqual([
      "DAP_DUTIES",
      "EU_LOW_VALUE_DUTY",
    ]);
    expect(evaluate("FR", 600.01, europeOn).notices).toEqual(["DAP_DUTIES"]);
    // CH is in the EUROPE zone but not in the EU.
    expect(evaluate("CH", 500, europeOn).notices).toEqual(["DAP_DUTIES"]);
  });

  it("US notices: duty-free with clearance fees; formal entry above USD 2,500", () => {
    expect(evaluate("US", 3200)).toEqual({
      mode: "ok",
      notices: ["DAP_DUTIES", "US_DUTY_FREE_CLEARANCE_FEES"],
    });
    // USD 2,500 × 3.7 = ₪9,250
    const over = evaluate("US", 9250.01, settings, "MOCK");
    expect(over.mode).toBe("ok");
    expect(over.notices).toEqual([
      "DAP_DUTIES",
      "US_DUTY_FREE_CLEARANCE_FEES",
      "US_FORMAL_ENTRY",
    ]);
  });

  it("VALUE_CAP above the carrier cap (DHL USD 2,500) routes to a quote", () => {
    expect(evaluate("CA", 9250).mode).toBe("ok");
    expect(evaluate("CA", 9250.01)).toEqual({
      mode: "quote_only",
      reason: "VALUE_CAP",
      notices: ["DAP_DUTIES"],
    });
    // No cap configured for the mock carrier.
    expect(evaluate("CA", 50_000, settings, "MOCK").mode).toBe("ok");
  });

  it("quoteOnlyCountries route to a quote", () => {
    const s = { ...settings, quoteOnlyCountries: ["JP"] };
    expect(evaluate("JP", 1000, s)).toMatchObject({
      mode: "quote_only",
      reason: "QUOTE_ONLY",
    });
  });
});

describe("NOT_INTERNATIONAL", () => {
  it("applies to works that do not ship abroad or are pickup only", async () => {
    const base: ArtworkShipSpec = {
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
      shipsInternationally: false,
      localPickupOnly: false,
      quoteOnly: false,
      maxInsurableValueMinor: null,
      dispatchDays: 5,
    };
    const q = quoteShipping({
      items: [base],
      country: "US",
      currency: "USD",
      date: new Date("2026-10-01T09:00:00Z"),
      declaredValueIlsMinor: 100_000,
      settings,
      fx,
      carrier: "DHL",
    });
    expect(q).toMatchObject({ mode: "blocked", reason: "NOT_INTERNATIONAL" });
  });
});

describe("§8.3: international checkout with the USD 2,500 DHL cap", () => {
  it("works for the six cheaper works; higher-value works route to a quote", async () => {
    const manifest = await readDemoManifest();
    const ok: string[] = [];
    const quote: string[] = [];
    for (const w of manifest.works) {
      if (w.status !== "AVAILABLE" || w.priceIls === null) continue;
      const p = demoPackaging(w);
      const q = quoteShipping({
        items: [
          {
            artworkId: w.slug,
            heightMm: w.heightMm,
            widthMm: w.widthMm,
            depthMm: p.depthMm,
            packagingType: p.packagingType,
            canBeRolled: w.canBeRolled,
            packedLengthMm: p.packedLengthMm,
            packedWidthMm: p.packedWidthMm,
            packedHeightMm: p.packedHeightMm,
            packedWeightG: p.packedWeightG,
            sizeClassOverride: null,
            glazing: "NONE",
            framed: false,
            shipsInternationally: w.shipsInternationally,
            localPickupOnly: false,
            quoteOnly: w.quoteOnly,
            maxInsurableValueMinor: null,
            dispatchDays: 5,
          },
        ],
        country: "CA",
        currency: "USD",
        date: new Date("2026-10-01T09:00:00Z"),
        declaredValueIlsMinor: w.priceIls * 100,
        settings,
        fx,
        carrier: "DHL",
      });
      (q.mode === "ok" ? ok : quote).push(w.slug);
    }
    expect(ok.sort()).toEqual(
      [
        "antibes",
        "icebound",
        "landscape-no-26",
        "movement-no-10",
        "still-life-green-flower-vase",
        "still-life-no-15",
      ].sort(),
    );
    expect(quote).toContain("beach-at-cabasson");
    expect(quote).toContain("banks-of-the-durance");
  });
});

describe("addresses", () => {
  it("requires Latin script abroad and allows Hebrew in Israel", () => {
    const address = {
      line1: "רחוב הרצל 1",
      city: "Tel Aviv",
      line2: "",
    };
    expect(nonLatinAddressFields("US", address)).toEqual(["line1"]);
    expect(nonLatinAddressFields("IL", address)).toEqual([]);
    expect(
      nonLatinAddressFields("FR", {
        line1: "12 Rue de l'Église",
        city: "Paris",
      }),
    ).toEqual([]);
  });
});
