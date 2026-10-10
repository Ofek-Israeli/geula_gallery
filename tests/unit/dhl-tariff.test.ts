import { describe, expect, it } from "vitest";
import { COUNTRY_CODES } from "@/lib/countries";
import {
  dhlDemandRegionOf,
  dhlPriceKey,
  dhlZoneOf,
} from "@/server/shipping/dhl-estimate";
import {
  DHL_TARIFFS,
  dhlTariffOn,
  DHL_EXPRESS_IL_2026 as T,
} from "@/server/shipping/tariff";

/**
 * The DHL Express 2026 Israel export tariff as code data (`src/server/shipping/tariff/`): the rows
 * extracted from DHL's rate guide must agree with the guide's own increments, and every country
 * of the selector has exactly one zone (or none).
 */
const ZONES = [1, 2, 3, 4, 5, 6] as const;
const row = (halfKilos: number) => {
  const r = T.rows.find(([w]) => w === halfKilos);
  if (!r) throw new Error(`no row ${halfKilos / 2} kg`);
  return r[1];
};
const D = new Date("2026-10-15T09:00:00Z");

describe("rate rows", () => {
  it("publishes 0.5–10 kg by 0.5 kg, 11–30 kg by 1 kg, and 40/50/60/70 kg", () => {
    const weights = T.rows.map(([w]) => w);
    const expected = [
      ...Array.from({ length: 20 }, (_, i) => i + 1),
      ...Array.from({ length: 20 }, (_, i) => 22 + 2 * i),
      80,
      100,
      120,
      140,
    ];
    expect(weights).toEqual(expected);
    for (const [, prices] of T.rows) expect(prices).toHaveLength(6);
  });

  it("matches the guide's 0.5 kg, 10 kg and 23 kg rows", () => {
    expect(row(1)).toEqual([18_556, 19_126, 23_514, 25_808, 26_408, 32_155]);
    expect(row(20)).toEqual([
      112_070, 126_275, 182_264, 196_089, 204_028, 244_987,
    ]);
    expect(row(46)).toEqual([
      177_930, 228_795, 300_942, 325_381, 385_004, 465_685,
    ]);
  });

  it("agrees with the published increments: 11–20 kg, 21–30 kg and 40–70 kg", () => {
    for (const z of ZONES) {
      const i = z - 1;
      for (let kg = 11; kg <= 20; kg++) {
        expect(row(2 * kg)[i], `zone ${z} ${kg} kg`).toBe(
          (row(20)[i] as number) +
            2 * (kg - 10) * (T.perHalfKgAbove10[i] as number),
        );
      }
      for (let kg = 21; kg <= 30; kg++) {
        expect(row(2 * kg)[i], `zone ${z} ${kg} kg`).toBe(
          (row(40)[i] as number) +
            2 * (kg - 20) * (T.perHalfKgAbove20[i] as number),
        );
      }
      for (const kg of [40, 50, 60, 70]) {
        expect(row(2 * kg)[i], `zone ${z} ${kg} kg`).toBe(
          (row(60)[i] as number) + (kg - 30) * (T.perKg30To70[i] as number),
        );
      }
    }
  });
});

describe("zones", () => {
  it("gives every selector country exactly one zone, or lists it as unpriced", () => {
    const listed = [
      ...ZONES.flatMap((z) => T.zones[z]),
      ...T.noZone,
      "IL",
    ].sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual([...COUNTRY_CODES].sort());
    expect(ZONES.map((z) => T.zones[z].length)).toEqual([
      3, 50, 2, 24, 22, 126,
    ]);
    expect(T.noZone).toHaveLength(21);
  });

  it("puts destinations where the guide does", () => {
    const zone = (c: string) => dhlZoneOf(c, D);
    expect(["US", "CA", "MX"].map(zone)).toEqual([1, 1, 1]);
    expect(["GB", "DE", "CH", "TR", "UA", "AM"].map(zone)).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
    expect(["CN", "HK"].map(zone)).toEqual([3, 3]);
    expect(["JP", "AU", "AE", "SG"].map(zone)).toEqual([4, 4, 4, 4]);
    expect(["BR", "AR", "SD"].map(zone)).toEqual([5, 5, 5]);
    expect(["ZA", "PR", "VI", "MO", "QA", "RU"].map(zone)).toEqual([
      6, 6, 6, 6, 6, 6,
    ]);
    expect(["AF", "IM", "AX", "PS", "IL"].map(zone)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("surcharge data", () => {
  it("maps demand regions from DHL's destination lists (Rest of the World otherwise)", () => {
    const region = (c: string) => dhlDemandRegionOf(c, D);
    expect(region("US")).toBe("AMERICAS");
    expect(region("PR")).toBe("AMERICAS");
    expect(region("DE")).toBe("EUROPE");
    expect(region("TR")).toBe("EUROPE");
    expect(region("JP")).toBe("ASIA");
    expect(region("AU")).toBe("OCEANIA");
    expect(region("MO")).toBe("CN_HK_MO");
    expect(region("AE")).toBe("MENA");
    for (const c of ["UA", "VE", "RU", "ZA", "FO", "GL"]) {
      expect(region(c), c).toBe("ROW");
    }
    const all = Object.values(T.demandRegions).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const c of all) expect(COUNTRY_CODES, c).toContain(c);
  });

  it("lists restricted and elevated-risk destinations; Israel's own elevated risk is suspended", () => {
    for (const c of [
      ...T.restrictedDestination.countries,
      ...T.elevatedRisk.countries,
    ]) {
      expect(COUNTRY_CODES, c).toContain(c);
    }
    expect(T.elevatedRisk.israelSuspendedSince).toBe("2026-09-25");
    expect(T.elevatedRisk.countries).not.toContain("IL");
    expect(T.demand).toEqual([
      expect.objectContaining({ from: "2026-10-01", to: "2027-02-05" }),
    ]);
  });

  it("groups destinations that cost the same (zone, region, per-shipment surcharges)", () => {
    const key = (c: string) => dhlPriceKey(c, D);
    expect(key("US")).toBe(key("CA"));
    expect(key("US")).toBe(key("MX"));
    expect(key("DE")).toBe(key("GB"));
    expect(key("UA")).not.toBe(key("GB")); // elevated risk, "Rest of the World" demand
    expect(key("JP")).not.toBe(key("AU")); // Asia vs Oceania demand
    expect(key("AF")).toBeNull();
  });

  it("selects the guide by date", () => {
    expect(DHL_TARIFFS).toEqual([T]);
    expect(dhlTariffOn(new Date("2026-01-01T00:00:00Z")).id).toBe(
      "DHL-EXPRESS-WORLDWIDE-IL-2026",
    );
    expect(dhlTariffOn(new Date("2025-06-01T00:00:00Z"))).toBe(T);
  });
});
