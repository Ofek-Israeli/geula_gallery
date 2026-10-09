import { describe, expect, it } from "vitest";
import { cartControl, cartNoticeOf } from "@/components/artwork/buy-box";
import {
  CART_COOKIE_MAX_IDS,
  parseCartCookie,
  serializeCartCookie,
} from "@/lib/cart";
import { paths } from "@/lib/routes";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("cart cookie codec", () => {
  it("round-trips ids in their order", () => {
    const ids = [id(3), id(1), id(2)];
    expect(parseCartCookie(serializeCartCookie(ids))).toEqual(ids);
    expect(serializeCartCookie(ids)).toBe(`v1.${ids.join(".")}`);
  });

  it("reads anything malformed as an empty cart or drops the bad parts", () => {
    expect(parseCartCookie(undefined)).toEqual([]);
    expect(parseCartCookie("")).toEqual([]);
    expect(parseCartCookie(`v2.${id(1)}`)).toEqual([]);
    expect(parseCartCookie(`v1.not-a-uuid.${id(1)}`)).toEqual([id(1)]);
  });

  it("lower-cases, de-duplicates and caps the ids", () => {
    expect(parseCartCookie(`v1.${id(1).toUpperCase()}.${id(1)}`)).toEqual([
      id(1),
    ]);
    const many = Array.from({ length: CART_COOKIE_MAX_IDS + 5 }, (_, i) =>
      id(i + 1),
    );
    expect(parseCartCookie(serializeCartCookie(many))).toHaveLength(
      CART_COOKIE_MAX_IDS,
    );
  });
});

describe("cart control and notices", () => {
  const buyable = { state: { kind: "available", buyable: true } } as const;
  it("offers Add to cart only for buyable works", () => {
    expect(cartControl(buyable, false)).toBe("add");
    expect(cartControl(buyable, true)).toBe("in_cart");
    expect(
      cartControl({ state: { kind: "available", buyable: false } }, false),
    ).toBeNull();
    expect(cartControl({ state: { kind: "sold" } }, false)).toBeNull();
    expect(
      cartControl({ state: { kind: "reserved", until: "x" } }, true),
    ).toBeNull();
  });

  it("accepts only known notice codes", () => {
    expect(cartNoticeOf("added")).toBe("added");
    expect(cartNoticeOf("full")).toBe("full");
    expect(cartNoticeOf("<script>")).toBeNull();
    expect(cartNoticeOf(undefined)).toBeNull();
  });
});

describe("cart routes", () => {
  it("builds the cart and cart checkout paths", () => {
    expect(paths.cart()).toBe("/cart");
    expect(paths.cart({ cart: "removed" })).toBe("/cart?cart=removed");
    expect(paths.cartCheckout()).toBe("/checkout");
    expect(paths.cartCheckout({ to: "US", ship: "CARRIER_TABLE" })).toBe(
      "/checkout?to=US&ship=CARRIER_TABLE",
    );
  });
});
