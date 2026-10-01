import { describe, expect, it } from "vitest";
import {
  type CommerceRow,
  commerceStateOf,
} from "@/server/catalog/commerce-state";

const now = new Date("2026-10-01T10:00:00Z");
const row = (over: Partial<CommerceRow> = {}): CommerceRow => ({
  saleStatus: "AVAILABLE",
  holdReason: null,
  reservedByOrderId: null,
  reservedUntil: null,
  isPublished: true,
  quoteOnly: false,
  priceOnRequest: false,
  priceIlsMinor: 320_000,
  holdInFlight: false,
  ...over,
});

describe("commerceStateOf (spec §3.5 Display)", () => {
  it("available and buyable only when published, priced and not quote-only", () => {
    expect(commerceStateOf(row(), now)).toEqual({
      kind: "available",
      buyable: true,
    });
    for (const over of [
      { quoteOnly: true },
      { priceOnRequest: true },
      { priceIlsMinor: null },
      { isPublished: false },
    ]) {
      expect(commerceStateOf(row(over), now)).toEqual({
        kind: "available",
        buyable: false,
      });
    }
  });

  it("a live foreign hold shows as reserved until reserved_until", () => {
    const until = new Date("2026-10-01T10:20:00Z");
    expect(
      commerceStateOf(
        row({ reservedByOrderId: "o", reservedUntil: until }),
        now,
      ),
    ).toEqual({ kind: "reserved", until: until.toISOString() });
  });

  it("an expired hold is available unless its payment is in flight", () => {
    const past = new Date("2026-10-01T09:00:00Z");
    expect(
      commerceStateOf(
        row({ reservedByOrderId: "o", reservedUntil: past }),
        now,
      ),
    ).toEqual({ kind: "available", buyable: true });
    expect(
      commerceStateOf(
        row({
          reservedByOrderId: "o",
          reservedUntil: past,
          holdInFlight: true,
        }),
        now,
      ).kind,
    ).toBe("reserved");
  });

  it("maps ON_HOLD, SOLD and NOT_FOR_SALE", () => {
    expect(
      commerceStateOf(
        row({ saleStatus: "ON_HOLD", holdReason: "RESERVED_OFFLINE" }),
        now,
      ),
    ).toEqual({ kind: "on_hold", reservedOffline: true });
    expect(
      commerceStateOf(
        row({ saleStatus: "ON_HOLD", holdReason: "EXHIBITION" }),
        now,
      ),
    ).toEqual({ kind: "on_hold", reservedOffline: false });
    expect(commerceStateOf(row({ saleStatus: "SOLD" }), now)).toEqual({
      kind: "sold",
    });
    expect(commerceStateOf(row({ saleStatus: "NOT_FOR_SALE" }), now)).toEqual({
      kind: "not_for_sale",
    });
  });
});
