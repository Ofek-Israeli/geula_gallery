import { describe, expect, it } from "vitest";
import {
  chargeableWeightG,
  cmToMm,
  formatCm,
  inchesToMm,
  mmToCm,
  orientationOf,
  sizeBucketOf,
  sortedDims,
  volumetricWeightG,
} from "@/lib/dimensions";

describe("dimensions", () => {
  it("converts units", () => {
    expect(mmToCm(605)).toBe(60.5);
    expect(formatCm(1234, "en")).toBe("123.4");
    expect(cmToMm(60.5)).toBe(605);
    expect(inchesToMm(10)).toBe(254);
  });

  it("derives orientation", () => {
    expect(orientationOf(600, 400)).toBe("PORTRAIT");
    expect(orientationOf(400, 600)).toBe("LANDSCAPE");
    expect(orientationOf(500, 510)).toBe("SQUARE");
    expect(orientationOf(300, 700)).toBe("PANORAMIC");
    expect(orientationOf(700, 300)).toBe("PORTRAIT");
    expect(() => orientationOf(0, 10)).toThrow(RangeError);
  });

  it("derives the size bucket from the longest side", () => {
    expect(sizeBucketOf(399, 100)).toBe("S");
    expect(sizeBucketOf(400, 100)).toBe("M");
    expect(sizeBucketOf(100, 799)).toBe("M");
    expect(sizeBucketOf(800, 100)).toBe("L");
    expect(sizeBucketOf(1200, 100)).toBe("XL");
  });

  it("computes volumetric and chargeable weight", () => {
    expect(sortedDims(100, 1000, 800)).toEqual([1000, 800, 100]);
    // 100 × 80 × 10 cm = 80,000 cm³ / 5000 = 16 kg.
    expect(volumetricWeightG(1000, 800, 100)).toBe(16000);
    expect(volumetricWeightG(1000, 800, 100, 4000)).toBe(20000);
    expect(
      chargeableWeightG(5000, { lengthMm: 1000, widthMm: 800, heightMm: 100 }),
    ).toBe(16000);
    expect(
      chargeableWeightG(30000, { lengthMm: 1000, widthMm: 800, heightMm: 100 }),
    ).toBe(30000);
    expect(() => volumetricWeightG(1, 1, 1, 0)).toThrow(RangeError);
  });
});
