import { describe, expect, it } from "vitest";
import {
  candidateMethods,
  insuredValueForDisplay,
  itemPriceMinor,
  orderAmounts,
} from "@/server/checkout/pricing";
import { insuredValueInCurrency } from "@/server/shipping/rates";

/** Spec §10.1 `pricing`: IL → ILS; USD rules; the insured value shown in the order currency. */
const art = {
  priceIlsMinor: 580_000,
  priceUsdMinor: 160_000,
  priceOnRequest: false,
} as Parameters<typeof itemPriceMinor>[0];

describe("pricing", () => {
  it("prices a work in the requested currency, or not at all", () => {
    expect(itemPriceMinor(art, "ILS")).toBe(580_000);
    expect(itemPriceMinor(art, "USD")).toBe(160_000);
    expect(itemPriceMinor({ ...art, priceUsdMinor: null }, "USD")).toBeNull();
    expect(itemPriceMinor({ ...art, priceOnRequest: true }, "ILS")).toBeNull();
  });

  it("offers pickup and artist delivery only in Israel", () => {
    expect(candidateMethods("IL")).toEqual([
      "CARRIER_TABLE",
      "LOCAL_PICKUP",
      "ARTIST_DELIVERY",
    ]);
    expect(candidateMethods("US")).toEqual(["CARRIER_TABLE"]);
  });

  it("totals items + shipping + insurance; VAT is included in IL and 0 on exports", () => {
    const quote = { shippingMinor: 10_000, insuranceMinor: 2_000 };
    const il = orderAmounts({
      itemsTotalMinor: 580_000,
      quote,
      vatMode: "OSEK_MURSHE",
      country: "IL",
      date: new Date("2026-10-01T10:00:00Z"),
    });
    expect(il.totalMinor).toBe(592_000);
    expect(il.vatRateBp).toBe(1800);
    expect(il.vatMinor).toBeGreaterThan(0);
    const us = orderAmounts({
      itemsTotalMinor: 160_000,
      quote,
      vatMode: "OSEK_MURSHE",
      country: "US",
      date: new Date("2026-10-01T10:00:00Z"),
    });
    expect(us.totalMinor).toBe(172_000);
    expect(us.vatMinor).toBe(0);
  });

  it("shows the insured value in the order currency, rounded down for USD", () => {
    const q = { insuredValueMinor: 580_000 };
    expect(insuredValueForDisplay(q, "ILS", 3.7)).toBe(580_000);
    // ₪5,800 / 3.7 = $1,567.57 → $1,567 (never more cover than the ILS cap).
    expect(insuredValueForDisplay(q, "USD", 3.7)).toBe(156_700);
    expect(insuredValueForDisplay({ ...q, fxIlsPerUsd: 4 }, "USD", 3.7)).toBe(
      145_000,
    );
    expect(insuredValueForDisplay({ insuredValueMinor: 0 }, "USD", 3.7)).toBe(
      0,
    );
    // The same conversion the DHL label declares (rates.ts#insuredValueInCurrency).
    expect(
      insuredValueForDisplay(
        { insuredValueMinor: 370_000, fxIlsPerUsd: 3.7 },
        "USD",
        3.7,
      ),
    ).toBe(
      insuredValueInCurrency({
        insured: true,
        insuredValueMinor: 370_000,
        currency: "USD",
        fxIlsPerUsd: 3.7,
      }),
    );
  });
});
