import { describe, expect, it } from "vitest";
import { stripBidi } from "@/lib/format";
import {
  addMoney,
  applyBasisPoints,
  formatMoney,
  fromDecimal,
  ilsToUsdCeilWhole,
  isCurrency,
  MoneyError,
  money,
  sumMinor,
  toDecimalString,
  toMajor,
  usdToIls,
  wholeToMinor,
} from "@/lib/money";

describe("formatMoney", () => {
  it("normalises RLM/NBSP and shows whole amounts without decimals", () => {
    expect(stripBidi(formatMoney(120000, "ILS", "en"))).toBe("₪1,200");
    expect(stripBidi(formatMoney(120000, "ILS", "he"))).toBe("1,200 ₪");
    expect(stripBidi(formatMoney(250000, "USD", "en"))).toBe("$2,500");
  });

  it("shows two decimals when there are cents", () => {
    expect(stripBidi(formatMoney(4550, "USD", "en"))).toBe("$45.50");
    expect(stripBidi(formatMoney(1, "ILS", "en"))).toBe("₪0.01");
  });

  it("rejects non-integer minor units", () => {
    expect(() => formatMoney(1.5, "ILS", "en")).toThrow(RangeError);
  });
});

describe("fromDecimal", () => {
  it("parses up to two decimal places into minor units", () => {
    expect(fromDecimal("1200")).toBe(120000);
    expect(fromDecimal("45.5")).toBe(4550);
    expect(fromDecimal("45.50")).toBe(4550);
    expect(fromDecimal(" 0.07 ")).toBe(7);
    expect(fromDecimal(12.34)).toBe(1234);
    expect(fromDecimal("-3.2")).toBe(-320);
  });

  it("rejects more than two places, separators, exponents and garbage", () => {
    for (const bad of ["12.345", "1,200", "1e3", "", "abc", ".5", "5."]) {
      expect(() => fromDecimal(bad), bad).toThrow(MoneyError);
    }
    expect(() => fromDecimal(0.123)).toThrow(MoneyError);
    expect(() => fromDecimal(Number.NaN)).toThrow(MoneyError);
    expect(() => fromDecimal(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("conversions", () => {
  it("formats 2-decimal strings for providers", () => {
    expect(toDecimalString(120000)).toBe("1200.00");
    expect(toDecimalString(5)).toBe("0.05");
    expect(toDecimalString(-5)).toBe("-0.05");
    expect(toMajor(4550)).toBe(45.5);
    expect(wholeToMinor(350)).toBe(35000);
  });

  it("converts ILS to USD rounded up to whole dollars", () => {
    expect(ilsToUsdCeilWhole(37000, 3.7)).toBe(10000);
    expect(ilsToUsdCeilWhole(37100, 3.7)).toBe(10100);
    expect(ilsToUsdCeilWhole(1, 3.7)).toBe(100);
    expect(ilsToUsdCeilWhole(0, 3.7)).toBe(0);
    expect(() => ilsToUsdCeilWhole(100, 0)).toThrow(MoneyError);
  });

  it("converts USD to ILS at the reference rate, half up", () => {
    expect(usdToIls(10000, 3.7)).toBe(37000);
    expect(usdToIls(1, 3.65)).toBe(4); // 3.65 → 4
    expect(usdToIls(1, 3.64)).toBe(4); // 3.64 → 4
    expect(usdToIls(1, 3.44)).toBe(3);
  });

  it("applies basis points with half-away-from-zero rounding", () => {
    expect(applyBasisPoints(150000, 500)).toBe(7500); // 5 % of ₪1,500
    expect(applyBasisPoints(2000000, 500)).toBe(100000);
    expect(applyBasisPoints(10, 500)).toBe(1); // 0.5 → 1
    expect(applyBasisPoints(-10, 500)).toBe(-1);
    expect(applyBasisPoints(9, 500)).toBe(0); // 0.45 → 0
  });

  it("adds and sums safely", () => {
    expect(sumMinor([100, 250, 1])).toBe(351);
    expect(addMoney(money(100, "ILS"), money(5, "ILS"))).toEqual({
      amountMinor: 105,
      currency: "ILS",
    });
    expect(() => addMoney(money(1, "ILS"), money(1, "USD"))).toThrow(
      MoneyError,
    );
    expect(() => money(0.5, "ILS")).toThrow(MoneyError);
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("EUR")).toBe(false);
  });
});
