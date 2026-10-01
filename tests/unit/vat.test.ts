import { describe, expect, it } from "vitest";
import {
  includedVatMinor,
  netOfVatMinor,
  PATUR_CEILING,
  paturCeilingLevel,
  paturCeilingMinor,
  VAT_RATES,
  vatForOrder,
  vatRateBpOn,
} from "@/lib/vat";

describe("VAT", () => {
  it("knows the 18 % rate from 2025-01-01", () => {
    expect(VAT_RATES[0]).toEqual({ from: "2025-01-01", rateBp: 1800 });
    expect(vatRateBpOn("2026-10-01")).toBe(1800);
    expect(vatRateBpOn(new Date("2025-01-01T00:30:00+02:00"))).toBe(1800);
    expect(() => vatRateBpOn("2024-12-31")).toThrow(RangeError);
  });

  it("uses the Israeli calendar day of an instant", () => {
    // 22:30 UTC on 31 Dec 2024 is already 1 Jan 2025 in Jerusalem.
    expect(vatRateBpOn(new Date("2024-12-31T22:30:00Z"))).toBe(1800);
  });

  it("computes VAT included in a gross price at 18 %", () => {
    expect(includedVatMinor(118000, 1800)).toBe(18000);
    expect(includedVatMinor(100000, 1800)).toBe(15254);
    expect(netOfVatMinor(118000, 1800)).toBe(100000);
    expect(includedVatMinor(100000, 0)).toBe(0);
  });

  it("is 0 for an osek patur and for zero-rated exports", () => {
    const base = { totalMinor: 118000, date: "2026-10-01" };
    expect(
      vatForOrder({ ...base, vatMode: "OSEK_PATUR", zeroRatedExport: false }),
    ).toEqual({ rateBp: 0, vatMinor: 0 });
    expect(
      vatForOrder({ ...base, vatMode: "OSEK_MURSHE", zeroRatedExport: true }),
    ).toEqual({ rateBp: 0, vatMinor: 0 });
    expect(
      vatForOrder({ ...base, vatMode: "OSEK_MURSHE", zeroRatedExport: false }),
    ).toEqual({ rateBp: 1800, vatMinor: 18000 });
  });

  it("has the patur ceiling by year", () => {
    expect(PATUR_CEILING[2026]).toBe(12_283_300);
    expect(paturCeilingMinor(2026)).toBe(12_283_300);
    expect(paturCeilingMinor(1999)).toBeNull();
    expect(paturCeilingLevel(0, 2026)).toBe("ok");
    expect(paturCeilingLevel(9_826_640, 2026)).toBe("warn80");
    expect(paturCeilingLevel(11_669_135, 2026)).toBe("warn95");
    expect(paturCeilingLevel(12_283_301, 2026)).toBe("over");
    expect(paturCeilingLevel(1, 1999)).toBe("unknown");
  });
});
