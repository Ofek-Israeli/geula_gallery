import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  env: { APP_ENV: "test", DATABASE_URL: "postgres://localhost/unused" },
}));

const { isReservable, isSellable } = await import(
  "@/server/checkout/reservations"
);
type LockedArtwork = import("@/server/checkout/reservations").LockedArtwork;

const now = new Date("2026-10-01T10:00:00Z");
const past = new Date("2026-10-01T09:00:00Z");
const future = new Date("2026-10-01T11:00:00Z");

function art(over: Partial<LockedArtwork> = {}): LockedArtwork {
  return {
    isPublished: true,
    saleStatus: "AVAILABLE",
    reservedByOrderId: null,
    reservedUntil: null,
    quoteOnly: false,
    priceOnRequest: false,
    ...over,
  } as LockedArtwork;
}

const ctx = { orderId: "o1", now, foreignHoldInFlight: false, web: true };

describe("reservation predicates (spec §3.5)", () => {
  it("free published available works are reservable and sellable", () => {
    expect(isReservable(art(), ctx)).toBe(true);
    expect(isSellable(art(), ctx)).toBe(true);
  });

  it("our own hold counts as free", () => {
    const a = art({ reservedByOrderId: "o1", reservedUntil: future });
    expect(isReservable(a, ctx)).toBe(true);
    expect(isSellable(a, ctx)).toBe(true);
  });

  it("a live foreign hold blocks; an expired one does not unless in flight", () => {
    const live = art({ reservedByOrderId: "o2", reservedUntil: future });
    expect(isReservable(live, ctx)).toBe(false);
    expect(isSellable(live, ctx)).toBe(false);
    const expired = art({ reservedByOrderId: "o2", reservedUntil: past });
    expect(isReservable(expired, ctx)).toBe(true);
    expect(isReservable(expired, { ...ctx, foreignHoldInFlight: true })).toBe(
      false,
    );
    expect(isSellable(expired, { ...ctx, foreignHoldInFlight: true })).toBe(
      false,
    );
  });

  it("web checkout refuses quote-only and price-on-request works; links may bypass", () => {
    expect(isReservable(art({ quoteOnly: true }), ctx)).toBe(false);
    expect(isReservable(art({ priceOnRequest: true }), ctx)).toBe(false);
    expect(isReservable(art({ quoteOnly: true }), { ...ctx, web: false })).toBe(
      true,
    );
  });

  it("publication matters for reserving, not for selling", () => {
    expect(isReservable(art({ isPublished: false }), ctx)).toBe(false);
    expect(isSellable(art({ isPublished: false }), ctx)).toBe(true);
    expect(isSellable(art({ saleStatus: "ON_HOLD" }), ctx)).toBe(false);
  });
});
