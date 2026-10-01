import { describe, expect, it } from "vitest";
import {
  aicArtistName,
  parseAicDimensions,
} from "../../scripts/lib/parse-aic-dimensions";

describe("parseAicDimensions (spec §8.2 data traps)", () => {
  it("parses a plain H × W cm string", () => {
    expect(parseAicDimensions("30.5 × 30.5 cm (12 × 12 in.)")).toEqual({
      heightMm: 305,
      widthMm: 305,
      depthMm: null,
    });
  });

  it("reads only the first segment and ignores the frame", () => {
    for (const [raw, h, w] of [
      [
        "65.3 × 92.3 cm (25 3/4 × 36 3/8 in.); Framed: 82.6 × 108.6 × 6.4 cm (32 1/2 × 42 3/4 × 2 1/2 in.)",
        653,
        923,
      ],
      [
        "49.2 × 51.3 cm (19 3/8 × 20 3/8 in.); Framed: 62.9 × 65.4 × 6.4 cm (24 3/4 × 25 3/4 × 2 1/2 in.)",
        492,
        513,
      ],
      [
        "70 × 59 cm (27 9/16 × 23 1/4 in.); Framed: 85.5 × 75.3 × 8.9 cm (33 5/8 × 29 5/8 × 3 1/2 in.)",
        700,
        590,
      ],
      [
        "62 × 148 cm (24 1/2 × 58 1/4 in.); Framed: 88.3 × 172.8 × 10.2 cm (34 3/4 × 68 × 4 in.)",
        620,
        1480,
      ],
    ] as const) {
      expect(parseAicDimensions(raw)).toEqual({
        heightMm: h,
        widthMm: w,
        depthMm: null,
      });
    }
  });

  it("parses a depth and an x separator", () => {
    expect(parseAicDimensions("10 x 20 x 3.5 cm")).toEqual({
      heightMm: 100,
      widthMm: 200,
      depthMm: 35,
    });
  });

  it("returns null without a cm measurement", () => {
    expect(parseAicDimensions("12 × 12 in.")).toBeNull();
    expect(parseAicDimensions("")).toBeNull();
  });
});

describe("aicArtistName", () => {
  it("drops nationality and dates, keeps the attribution", () => {
    expect(aicArtistName("Marsden Hartley (American, 1877–1943)")).toBe(
      "Marsden Hartley",
    );
    expect(
      aicArtistName("Attributed to Henri Edmond Cross\nFrench, 1856-1910"),
    ).toBe("Attributed to Henri Edmond Cross");
    expect(aicArtistName("Maurice Prendergast\nAmerican, 1858-1924")).toBe(
      "Maurice Prendergast",
    );
  });
});
