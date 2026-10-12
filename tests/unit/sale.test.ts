import { describe, expect, it } from "vitest";
import {
  activeSale,
  applySale,
  type SaleConfig,
  salePriceMinor,
} from "@/lib/sale";

/** The site-wide sale (`src/lib/sale.ts`): its window in Israel time and the rounded sale price. */
const sale: SaleConfig = {
  enabled: true,
  percentOff: 50,
  startsOn: "2026-10-12",
  endsOn: "2026-12-31",
  label: { he: "מבצע סוף שנה – 50% הנחה", en: "End-of-Year Sale – 50% Off" },
};

describe("activeSale", () => {
  it("runs from the first day to the last day, inclusive, in Israel time", () => {
    // 2026-10-12 00:10 in Israel is 2026-10-11 21:10 UTC (IDT, UTC+3).
    expect(activeSale(sale, new Date("2026-10-11T21:10:00Z"))).toEqual({
      percentOff: 50,
      label: sale.label,
      endsOn: "2026-12-31",
      perWork: {},
    });
    expect(activeSale(sale, new Date("2026-10-11T20:50:00Z"))).toBeNull();
    // 31 December 23:59 in Israel (IST, UTC+2) is still on; 1 January 00:00 is off.
    expect(activeSale(sale, new Date("2026-12-31T21:59:00Z"))).not.toBeNull();
    expect(activeSale(sale, new Date("2026-12-31T22:00:00Z"))).toBeNull();
  });

  it("is off when disabled or absent, and open-ended without dates", () => {
    const day = new Date("2026-11-01T10:00:00Z");
    expect(activeSale({ ...sale, enabled: false }, day)).toBeNull();
    expect(activeSale(null, day)).toBeNull();
    expect(activeSale(undefined, day)).toBeNull();
    expect(
      activeSale({ ...sale, startsOn: null, endsOn: null }, day),
    ).toMatchObject({ percentOff: 50, endsOn: null });
  });
});

describe("salePriceMinor", () => {
  it("takes the percentage off and rounds to whole shekels or dollars", () => {
    expect(salePriceMinor(400_000, 50)).toBe(200_000);
    expect(salePriceMinor(335_000, 50)).toBe(167_500);
    expect(salePriceMinor(123_456, 50)).toBe(61_700);
    expect(salePriceMinor(99_900, 30)).toBe(69_900);
    expect(salePriceMinor(100, 90)).toBe(100);
  });

  it("uses a work's own percentage when it has one", () => {
    const on = activeSale(
      { ...sale, perWork: { dancer: 20 } },
      new Date("2026-11-01T10:00:00Z"),
    );
    // ₪12,500 at 20 % → ₪10,000; other works keep the sale's 50 %.
    expect(applySale(1_250_000, on, "dancer")).toBe(1_000_000);
    expect(applySale(1_250_000, on, "other")).toBe(625_000);
  });

  it("leaves a missing price or no sale alone", () => {
    const on = activeSale(sale, new Date("2026-11-01T10:00:00Z"));
    expect(applySale(null, on, "a")).toBeNull();
    expect(applySale(400_000, null, "a")).toBe(400_000);
    expect(applySale(400_000, on, "a")).toBe(200_000);
  });
});
