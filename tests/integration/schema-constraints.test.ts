import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { artworks, orders, paymentAttempts, sales } from "@/server/db/schema";
import { cleanDatabaseBeforeEach, expectPgError } from "../helpers/db";
import {
  insertArtwork,
  insertOrder,
  insertPaymentAttempt,
  insertSale,
} from "../helpers/factories/core";

/**
 * Spec §10.3 `schema-constraints`: the database itself refuses a second active sale, a second
 * winning payment attempt, inconsistent reservations, IL orders in USD, live demo payments,
 * wrong totals and deleting an order that still holds a reservation (§1.1, §3.4).
 */
cleanDatabaseBeforeEach();

const UNIQUE = "23505";
const CHECK = "23514";
/** ON DELETE RESTRICT (`restrict_violation`), raised before NO ACTION's 23503. */
const RESTRICT = "23001";

describe("one sale per artwork (§3.4)", () => {
  it("rejects a second active sale for the same artwork", async () => {
    const art = await insertArtwork(db);
    await insertSale(db, { artworkId: art.id });
    await expectPgError(
      insertSale(db, { artworkId: art.id }),
      UNIQUE,
      "sales_one_active_per_artwork_idx",
    );
  });

  it("allows a new sale once the previous one is voided", async () => {
    const art = await insertArtwork(db);
    const first = await insertSale(db, { artworkId: art.id });
    await db
      .update(sales)
      .set({ voidedAt: new Date(), voidReason: "test relist" })
      .where(eq(sales.id, first.id));
    const second = await insertSale(db, { artworkId: art.id });
    expect(second.id).not.toBe(first.id);
  });

  it("rejects a second active sale for the same order item", async () => {
    const [a, b] = [await insertArtwork(db), await insertArtwork(db)];
    const { order, items } = await insertOrder(db, { artworks: [a] });
    const item = items[0];
    if (!item) throw new Error("no item");
    await insertSale(db, {
      artworkId: a.id,
      channel: "ONLINE",
      orderId: order.id,
      orderItemId: item.id,
    });
    await expectPgError(
      insertSale(db, {
        artworkId: b.id,
        channel: "ONLINE",
        orderId: order.id,
        orderItemId: item.id,
      }),
      UNIQUE,
      "sales_one_active_per_order_item_idx",
    );
  });

  it("requires an order for ONLINE sales", async () => {
    const art = await insertArtwork(db);
    await expectPgError(
      insertSale(db, { artworkId: art.id, channel: "ONLINE" }),
      CHECK,
      "sales_online_has_order",
    );
  });
});

describe("one winning payment attempt per order (§3.4)", () => {
  for (const second of ["SUCCEEDED", "CAPTURING", "PAYMENT_REVIEW"] as const) {
    it(`rejects ${second} next to a SUCCEEDED attempt`, async () => {
      const art = await insertArtwork(db);
      const { order } = await insertOrder(db, { artworks: [art] });
      await insertPaymentAttempt(db, order, { seq: 1, status: "SUCCEEDED" });
      await expectPgError(
        insertPaymentAttempt(db, order, { seq: 2, status: second }),
        UNIQUE,
        "payment_attempts_one_winner_idx",
      );
    });
  }

  it("allows any number of non-winning attempts", async () => {
    const art = await insertArtwork(db);
    const { order } = await insertOrder(db, { artworks: [art] });
    await insertPaymentAttempt(db, order, { seq: 1, status: "SUCCEEDED" });
    await insertPaymentAttempt(db, order, { seq: 2, status: "FAILED" });
    await insertPaymentAttempt(db, order, { seq: 3, status: "NEEDS_REFUND" });
    await insertPaymentAttempt(db, order, { seq: 4, status: "CANCELED" });
  });

  it("refuses a winning update that would create a second winner", async () => {
    const art = await insertArtwork(db);
    const { order } = await insertOrder(db, { artworks: [art] });
    await insertPaymentAttempt(db, order, { seq: 1, status: "SUCCEEDED" });
    const other = await insertPaymentAttempt(db, order, {
      seq: 2,
      status: "PENDING",
    });
    await expectPgError(
      db
        .update(paymentAttempts)
        .set({ status: "SUCCEEDED" })
        .where(eq(paymentAttempts.id, other.id)),
      UNIQUE,
      "payment_attempts_one_winner_idx",
    );
  });
});

describe("reservation CHECKs (§3.5)", () => {
  it("requires reserved_by_order_id and reserved_until together", async () => {
    const art = await insertArtwork(db);
    const { order } = await insertOrder(db, { artworks: [art] });
    await expectPgError(
      db
        .update(artworks)
        .set({ reservedByOrderId: order.id })
        .where(eq(artworks.id, art.id)),
      CHECK,
      "artworks_reservation_pair",
    );
    await expectPgError(
      db
        .update(artworks)
        .set({ reservedUntil: new Date(Date.now() + 60_000) })
        .where(eq(artworks.id, art.id)),
      CHECK,
      "artworks_reservation_pair",
    );
  });

  it("allows a reservation only on AVAILABLE artworks", async () => {
    const art = await insertArtwork(db, {
      saleStatus: "SOLD",
      soldAt: new Date(),
    });
    const { order } = await insertOrder(db, { artworks: [art] });
    await expectPgError(
      db
        .update(artworks)
        .set({
          reservedByOrderId: order.id,
          reservedUntil: new Date(Date.now() + 60_000),
        })
        .where(eq(artworks.id, art.id)),
      CHECK,
      "artworks_reserved_only_available",
    );
  });

  it("requires sold_at on SOLD artworks", async () => {
    await expectPgError(
      insertArtwork(db, { saleStatus: "SOLD" }),
      CHECK,
      "artworks_sold_has_sold_at",
    );
  });

  it("restricts deleting an order that still holds a reservation", async () => {
    const art = await insertArtwork(db);
    // No order items, so the only reference to the order is the reservation.
    const { order } = await insertOrder(db, { artworks: [] });
    await db
      .update(artworks)
      .set({
        reservedByOrderId: order.id,
        reservedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(artworks.id, art.id));
    await expectPgError(
      db.delete(orders).where(eq(orders.id, order.id)),
      RESTRICT,
      "artworks_reserved_by_order_id_orders_id_fk",
    );
  });
});

describe("order and payment CHECKs (§1.1)", () => {
  it("makes Israeli destinations pay in ILS", async () => {
    const art = await insertArtwork(db, { priceUsdMinor: 40_000 });
    await expectPgError(
      insertOrder(db, {
        artworks: [art],
        overrides: { currency: "USD", shipCountry: "IL" },
      }),
      CHECK,
      "orders_il_pays_ils",
    );
    const { order } = await insertOrder(db, {
      artworks: [art],
      overrides: { currency: "USD", shipCountry: "US", locale: "en" },
    });
    expect(order.currency).toBe("USD");
  });

  it("never lets a demo payment use a LIVE provider", async () => {
    const art = await insertArtwork(db, { isDemo: true });
    const { order } = await insertOrder(db, {
      artworks: [art],
      overrides: { isDemo: true },
    });
    await expectPgError(
      insertPaymentAttempt(db, order, {
        provider: "CARDCOM",
        providerMode: "LIVE",
        isDemo: true,
      }),
      CHECK,
      "payment_attempts_demo_not_live",
    );
    const ok = await insertPaymentAttempt(db, order, {
      provider: "CARDCOM",
      providerMode: "TEST",
      isDemo: true,
    });
    expect(ok.providerMode).toBe("TEST");
  });

  it("keeps the mock provider in MOCK mode", async () => {
    const art = await insertArtwork(db);
    const { order } = await insertOrder(db, { artworks: [art] });
    await expectPgError(
      insertPaymentAttempt(db, order, {
        providerMode: "TEST",
      }),
      CHECK,
      "payment_attempts_mock_mode",
    );
  });

  it("requires total = items + shipping + insurance", async () => {
    const art = await insertArtwork(db);
    await expectPgError(
      insertOrder(db, {
        artworks: [art],
        overrides: { shippingMinor: 5_000, totalMinor: 150_000 },
      }),
      CHECK,
      "orders_total_sum",
    );
  });

  it("requires a paid attempt for PAID orders", async () => {
    const art = await insertArtwork(db);
    await expectPgError(
      insertOrder(db, { artworks: [art], overrides: { status: "PAID" } }),
      CHECK,
      "orders_paid_has_attempt",
    );
  });

  it("rejects non-positive attempt amounts", async () => {
    const art = await insertArtwork(db);
    const { order } = await insertOrder(db, { artworks: [art] });
    await expectPgError(
      insertPaymentAttempt(db, order, { amountMinor: 0 }),
      CHECK,
      "payment_attempts_amount_positive",
    );
  });
});
