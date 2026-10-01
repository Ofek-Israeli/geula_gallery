import { describe, expect, it } from "vitest";
import {
  contentsDescriptionShort,
  customsDescriptionEn,
  declaredValueUsdMinor,
  EXPORT_COMMODITY_CODE,
  exportDeclarationRequired,
  HS_CODE,
  importCommodityCode,
} from "@/server/shipping/customs";

describe("customs (spec §4.4)", () => {
  it("uses HS 9701.91 with the destination extensions", () => {
    expect(HS_CODE).toBe("9701.91");
    expect(EXPORT_COMMODITY_CODE).toBe("9701910000");
    expect(importCommodityCode("US")).toBe("9701.91.0000");
    expect(importCommodityCode("DE")).toBe("97019100");
    expect(importCommodityCode("FR")).toBe("97019100");
    expect(importCommodityCode("IL")).toBe("9701910000");
    expect(importCommodityCode("JP")).toBe("9701.91");
    expect(importCommodityCode("GB")).toBe("9701.91");
  });

  it("generates the English description", () => {
    expect(
      customsDescriptionEn({
        mediumText: "Oil on canvas",
        yearCreated: 2024,
        artistName: "Geula Example",
      }),
    ).toBe(
      "Original painting, oil on canvas, by Geula Example (2024). Hand-painted unique work of art, not a reproduction.",
    );
    expect(
      customsDescriptionEn({
        mediumText: "",
        artistName: "",
        yearCreated: null,
      }),
    ).toBe(
      "Original painting. Hand-painted unique work of art, not a reproduction.",
    );
    expect(contentsDescriptionShort("Watercolor on paper")).toBe(
      "Original painting (watercolor on paper)",
    );
    expect(contentsDescriptionShort("x".repeat(80))).toBe("Original painting");
  });

  it("requires an export declaration strictly above USD 200", () => {
    expect(exportDeclarationRequired(20_000, 200)).toBe(false);
    expect(exportDeclarationRequired(20_001, 200)).toBe(true);
    // ₪740 at 3.7 = $200.00 → not required; ₪741 → required.
    expect(declaredValueUsdMinor(74_000, "ILS", 3.7)).toBe(20_000);
    expect(
      exportDeclarationRequired(declaredValueUsdMinor(74_100, "ILS", 3.7), 200),
    ).toBe(true);
    expect(declaredValueUsdMinor(12_345, "USD", 3.7)).toBe(12_345);
  });
});

describe("declaredLineValues", () => {
  it("splits the declared total by weight and always adds up", async () => {
    const { declaredLineValues } = await import("@/server/shipping/customs");
    expect(declaredLineValues(185_000, [690_000])).toEqual([185_000]);
    expect(declaredLineValues(100_00, [1, 1, 1])).toEqual([3333, 3333, 3334]);
    const split = declaredLineValues(207_100, [690_000, 310_000]);
    expect(split.reduce((s, v) => s + v, 0)).toBe(207_100);
    expect(split[0]).toBe(142_899);
    expect(declaredLineValues(500, [0, 0])).toEqual([250, 250]);
    expect(declaredLineValues(500, [])).toEqual([]);
  });
});
