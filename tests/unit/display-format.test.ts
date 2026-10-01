import { describe, expect, it } from "vitest";
import {
  formatCm,
  formatDimensions,
  formatInches,
  mmToEighths,
} from "@/lib/dimensions";
import { formatMoney } from "@/lib/money";

/** Tests normalise U+200F (RLM), U+200E (LRM) and U+00A0 (spec §6.4). */
const norm = (s: string) => s.replace(/[‏‎]/g, "").replace(/ /g, " ");

describe("formatMoney", () => {
  it("shows whole amounts without decimals", () => {
    expect(norm(formatMoney(120000, "ILS", "en"))).toBe("₪1,200");
    expect(norm(formatMoney(120000, "ILS", "he"))).toBe("1,200 ₪");
    expect(norm(formatMoney(4550, "USD", "en"))).toBe("$45.50");
  });

  it("rejects non-integer minor units", () => {
    expect(() => formatMoney(1.5, "ILS", "en")).toThrow(RangeError);
  });
});

describe("dimensions", () => {
  it("converts to cm with one decimal and inches to the nearest 1/8", () => {
    expect(formatCm(605, "en")).toBe("60.5");
    expect(formatCm(600, "he")).toBe("60");
    expect(mmToEighths(25.4)).toBe(8);
    expect(formatInches(600)).toBe("23⅝");
    expect(formatInches(3)).toBe("⅛");
    expect(
      formatDimensions({ heightMm: 600, widthMm: 400, depthMm: 20 }, "en"),
    ).toEqual({
      cm: "60 × 40 × 2",
      inches: "23⅝ × 15¾ × ¾",
    });
  });
});
