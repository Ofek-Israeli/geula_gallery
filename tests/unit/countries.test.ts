import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES,
  countryName,
  countryOptions,
  DEFAULT_DENIED_COUNTRIES,
  defaultZoneOf,
  EU27,
  EUROPE_ZONE_COUNTRIES,
  isCountryCode,
  isEuCountry,
  parseCountryCode,
  zoneOf,
} from "@/lib/countries";

describe("countries", () => {
  it("lists the 249 ISO 3166-1 alpha-2 codes, unique and sorted", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect([...COUNTRY_CODES].sort()).toEqual([...COUNTRY_CODES]);
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of COUNTRY_CODES) {
      expect(dn.of(code), code).not.toBe(code);
    }
  });

  it("validates and parses codes", () => {
    expect(isCountryCode("IL")).toBe(true);
    expect(isCountryCode("il")).toBe(false);
    expect(isCountryCode("XX")).toBe(false);
    expect(parseCountryCode(" us ")).toBe("US");
    expect(parseCountryCode("UK")).toBeNull();
  });

  it("has the default zones", () => {
    expect(EU27).toHaveLength(27);
    expect(EUROPE_ZONE_COUNTRIES).toHaveLength(30);
    expect(isEuCountry("FR")).toBe(true);
    expect(isEuCountry("GB")).toBe(false);
    expect(defaultZoneOf("IL")).toBe("IL");
    expect(defaultZoneOf("GB")).toBe("EUROPE");
    expect(defaultZoneOf("CH")).toBe("EUROPE");
    expect(defaultZoneOf("US")).toBe("NORTH_AMERICA");
    expect(defaultZoneOf("CA")).toBe("NORTH_AMERICA");
    expect(defaultZoneOf("JP")).toBe("REST_OF_WORLD");
    expect(DEFAULT_DENIED_COUNTRIES).toEqual(["IR", "SY", "LB", "IQ"]);
  });

  it("resolves zones from settings (explicit, then wildcard)", () => {
    const zones = [
      { id: "IL" as const, countries: ["IL"] },
      { id: "NORTH_AMERICA" as const, countries: ["US", "CA"] },
      { id: "REST_OF_WORLD" as const, countries: ["*"] },
    ];
    expect(zoneOf("US", zones)).toBe("NORTH_AMERICA");
    expect(zoneOf("FR", zones)).toBe("REST_OF_WORLD");
    expect(zoneOf("FR", [])).toBe("REST_OF_WORLD");
  });

  it("names and sorts countries per locale, Israel first, deny list removed", () => {
    expect(countryName("DE", "en")).toBe("Germany");
    expect(countryName("DE", "he")).toBe("גרמניה");
    const he = countryOptions("he");
    expect(he[0]?.code).toBe("IL");
    const codes = he.map((o) => o.code);
    for (const denied of DEFAULT_DENIED_COUNTRIES) {
      expect(codes).not.toContain(denied);
    }
    expect(codes).not.toContain("AQ");
    const en = countryOptions("en", ["IR", "SY", "LB"]).map((o) => o.code);
    expect(en).toContain("IQ");
    const names = countryOptions("en")
      .slice(1)
      .map((o) => o.name);
    const collator = new Intl.Collator("en-IL");
    expect([...names].sort(collator.compare)).toEqual(names);
  });
});
