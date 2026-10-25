import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach, testEnv } from "../helpers/db";
import {
  buyableArtwork,
  cartCheckoutInput,
  clickMockPay,
  execSql,
  heldCartOrder,
  heldOrder,
  patchSetting,
  startCartCheckout,
} from "../helpers/factories/commerce";
import { uniqueBuyer } from "../helpers/factories/core";
import { partition, race } from "../helpers/race";

/**
 * The cart checkout: several works, one delivery choice, one payment. The N-item quote (per-work
 * prices and problems), the all-or-nothing hold, the per-artwork caps, the cart limit, mixed
 * demo/real refusal, finalization of a multi-work order, a lost work refunding everything, the
 * cleanup of a taken-over cart's other holds, and overlapping carts under real concurrency.
 */
const { db } = await import("@/server/db/client");
const { artworks, orderItems, orders, paymentAttempts, refunds, sales } =
  await import("@/server/db/schema");
const { getCheckoutQuote } = await import("@/server/checkout/quote");
const { parseEnv } = await import("@/server/env");
const { startCheckout } = await import("@/server/checkout/start");
const { releaseReservation } = await import("@/server/checkout/release");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { checkInvariants } = await import("@/server/invariants");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

async function art(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!row) throw new Error("artwork missing");
  return row;
}
async function order(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order missing");
  return row;
}
async function expire(orderId: string, artworkIds: string[]) {
  await execSql(
    "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = ANY($1::uuid[])",
    [artworkIds],
  );
  await execSql(
    "UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1",
    [orderId],
  );
}
const finalize = (attemptId: string) =>
  finalizeAttempt(attemptId, { trigger: "webhook" }).then((r) => r.result);

describe("cart quote", () => {
  it("prices every work in cart order, with one delivery for the order", async () => {
    const a = await buyableArtwork(db, { priceIlsMinor: 100_000 });
    const b = await buyableArtwork(db, { priceIlsMinor: 250_000 });
    const c = await buyableArtwork(db, { priceIlsMinor: 175_000 });
    const quote = await getCheckoutQuote({
      artworkIds: [b.id, a.id, c.id],
      locale: "en",
      country: "IL",
      method: "LOCAL_PICKUP",
    });
    if (quote.kind !== "ok") throw new Error(quote.reason);
    expect(quote.items.map((i) => [i.artworkId, i.priceMinor])).toEqual([
      [b.id, 250_000],
      [a.id, 100_000],
      [c.id, 175_000],
    ]);
    expect(quote.itemsTotalMinor).toBe(525_000);
    // Pickup from the studio is one flat fee per order (seed: free).
    expect(quote.shipping.method).toBe("LOCAL_PICKUP");
    expect(quote.shipping.shippingMinor).toBe(0);
    expect(quote.totalMinor).toBe(
      525_000 + quote.shipping.shippingMinor + quote.shipping.insuranceMinor,
    );
  });

  it("offers USD only when every work has a USD price", async () => {
    const a = await buyableArtwork(db);
    const b = await buyableArtwork(db, { priceUsdMinor: null });
    const both = await getCheckoutQuote({
      artworkIds: [a.id, b.id],
      locale: "en",
      country: "US",
      currency: "USD",
    });
    if (both.kind !== "ok") throw new Error(both.reason);
    expect(both.usdAvailable).toBe(false);
    expect(both.currency).toBe("ILS");
  });

  it("with sales open, offers USD only when a payment method takes it", async () => {
    const a = await buyableArtwork(db);
    // Cardcom in shekels only (placeholder credentials): a dollar checkout would have no provider.
    const ilsOnly = parseEnv({
      ...testEnv(),
      PAYMENT_PROVIDERS: "cardcom",
      CARDCOM_MODE: "test",
      CARDCOM_TERMINAL_NUMBER: "1000",
      CARDCOM_API_NAME: "test-placeholder-api-name",
      CARDCOM_CURRENCIES: "ILS",
    });
    const req = {
      artworkIds: [a.id],
      locale: "en" as const,
      country: "US",
      currency: "USD" as const,
    };
    const ils = await getCheckoutQuote(req, { env: ilsOnly });
    if (ils.kind !== "ok") throw new Error(ils.reason);
    expect(ils.usdAvailable).toBe(false);
    expect(ils.currency).toBe("ILS");
    expect(ils.providers.map((p) => p.id)).toEqual(["cardcom"]);

    const withUsd = await getCheckoutQuote(req, {
      env: parseEnv({ ...testEnv(), CARDCOM_CURRENCIES: "ILS,USD" }),
    });
    if (withUsd.kind !== "ok") throw new Error(withUsd.reason);
    expect(withUsd.usdAvailable).toBe(true);
    expect(withUsd.currency).toBe("USD");
  });

  it("names every unavailable work and refuses demo mixed with real works", async () => {
    const a = await buyableArtwork(db);
    const sold = await buyableArtwork(db);
    const quoteOnly = await buyableArtwork(db, { quoteOnly: true });
    await execSql(
      "UPDATE artworks SET sale_status = 'SOLD', sold_at = now() WHERE id = $1",
      [sold.id],
    );
    const blocked = await getCheckoutQuote({
      artworkIds: [a.id, sold.id, quoteOnly.id],
      locale: "en",
    });
    expect(blocked).toMatchObject({
      kind: "blocked",
      reason: "NOT_AVAILABLE",
      artworkId: sold.id,
      problems: [
        { artworkId: sold.id, reason: "NOT_AVAILABLE" },
        { artworkId: quoteOnly.id, reason: "QUOTE_ONLY" },
      ],
    });

    const real = await buyableArtwork(db, { isDemo: false });
    const mixed = await getCheckoutQuote({
      artworkIds: [a.id, real.id],
      locale: "en",
    });
    expect(mixed).toMatchObject({
      kind: "blocked",
      reason: "MIXED_DEMO",
      problems: [{ artworkId: a.id, reason: "MIXED_DEMO" }],
    });
  });

  it("names the work that cannot ship abroad", async () => {
    const a = await buyableArtwork(db);
    const domestic = await buyableArtwork(db, { shipsInternationally: false });
    const q = await getCheckoutQuote({
      artworkIds: [a.id, domestic.id],
      locale: "en",
      country: "US",
    });
    expect(q).toMatchObject({
      kind: "blocked",
      reason: "NOT_INTERNATIONAL",
      artworkId: domestic.id,
      problems: [{ artworkId: domestic.id, reason: "NOT_INTERNATIONAL" }],
    });
    // In Israel the same cart can be collected from the studio.
    const il = await getCheckoutQuote({
      artworkIds: [a.id, domestic.id],
      locale: "en",
      country: "IL",
      method: "LOCAL_PICKUP",
    });
    expect(il.kind).toBe("ok");
  });

  it("refuses more works than maxCartItems", async () => {
    await patchSetting("checkout", { maxCartItems: 2 });
    const works = await Promise.all([1, 2, 3].map(() => buyableArtwork(db)));
    const q = await getCheckoutQuote({
      artworkIds: works.map((w) => w.id),
      locale: "en",
    });
    expect(q).toMatchObject({ kind: "blocked", reason: "TOO_MANY_ITEMS" });
  });
});

describe("cart start", () => {
  it("holds every work in one order with one attempt for the total", async () => {
    const works = await Promise.all(
      [100_000, 200_000, 300_000].map((p) =>
        buyableArtwork(db, { priceIlsMinor: p }),
      ),
    );
    const ids = works.map((w) => w.id);
    const { result } = await startCartCheckout(ids);
    if (result.kind !== "redirect") throw new Error(result.kind);
    expect([...result.artworkIds].sort()).toEqual([...ids].sort());
    const o = await order(result.orderId);
    expect(o.itemsTotalMinor).toBe(600_000);
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, o.id));
    expect(items.map((i) => [i.artworkId, i.priceMinor]).sort()).toEqual(
      works.map((w) => [w.id, w.priceIlsMinor]).sort(),
    );
    const held = await db
      .select()
      .from(artworks)
      .where(inArray(artworks.id, ids));
    expect(held.every((a) => a.reservedByOrderId === o.id)).toBe(true);
    expect(new Set(held.map((a) => a.reservedUntil?.getTime())).size).toBe(1);
    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, o.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.amountMinor).toBe(o.totalMinor);
  });

  it("refuses a cart over maxCartItems without writing anything", async () => {
    const works = await Promise.all([1, 2, 3].map(() => buyableArtwork(db)));
    const input = await cartCheckoutInput(works.map((w) => w.id));
    await patchSetting("checkout", { maxCartItems: 2 });
    const { result } = await startCheckout(input);
    expect(result).toMatchObject({ kind: "refused", code: "TOO_MANY_ITEMS" });
    expect(await db.$count(orders)).toBe(0);
  });

  it("an item price change that keeps the total is still price_changed", async () => {
    const a = await buyableArtwork(db, { priceIlsMinor: 100_000 });
    const b = await buyableArtwork(db, { priceIlsMinor: 200_000 });
    const input = await cartCheckoutInput([a.id, b.id]);
    await execSql(
      "UPDATE artworks SET price_ils_minor = CASE WHEN id = $1 THEN 200000 ELSE 100000 END WHERE id = ANY($2::uuid[])",
      [a.id, [a.id, b.id]],
    );
    const { result } = await startCheckout(input);
    expect(result.kind).toBe("price_changed");
    expect(await db.$count(orders)).toBe(0);
  });

  it("one work reserved by another buyer: just_reserved names it, nothing else is held", async () => {
    const a = await buyableArtwork(db);
    const b = await buyableArtwork(db);
    const input = await cartCheckoutInput([a.id, b.id]);
    await heldOrder(b.slug);
    const { result } = await startCheckout(input);
    expect(result).toEqual({ kind: "just_reserved", artworkIds: [b.id] });
    expect((await art(a.id)).reservedByOrderId).toBeNull();
  });

  it("a work sold between the quote and the start is named", async () => {
    const a = await buyableArtwork(db);
    const b = await buyableArtwork(db);
    const input = await cartCheckoutInput([a.id, b.id]);
    await execSql(
      "UPDATE artworks SET sale_status = 'SOLD', sold_at = now() WHERE id = $1",
      [a.id],
    );
    const { result } = await startCheckout(input);
    expect(result).toEqual({ kind: "just_reserved", artworkIds: [a.id] });
  });
});

describe("cart hold caps", () => {
  it("judges each work on its own history (regression: the union over the cart)", async () => {
    const buyer = uniqueBuyer();
    const ipHash = "ip-cart-history";
    const a = await buyableArtwork(db);
    const b = await buyableArtwork(db);
    for (const w of [a, b]) {
      const h = await heldOrder(w.slug, { buyer, ipHash });
      await releaseReservation({
        orderId: h.orderId,
        actor: "buyer:test",
        reason: "RELEASED",
      });
    }
    const { result } = await startCartCheckout([a.id, b.id], {
      buyer,
      ipHash,
    });
    expect(result.kind).toBe("redirect");
  });

  it("names the work over its 24 h budget", async () => {
    const buyer = uniqueBuyer();
    const ipHash = "ip-cart-budget";
    const a = await buyableArtwork(db);
    const c = await buyableArtwork(db);
    for (let i = 0; i < 2; i++) {
      const h = await heldOrder(a.slug, { buyer, ipHash });
      await releaseReservation({
        orderId: h.orderId,
        actor: "buyer:test",
        reason: "RELEASED",
      });
    }
    const { result } = await startCartCheckout([a.id, c.id], {
      buyer,
      ipHash,
    });
    expect(result).toEqual({
      kind: "refused",
      code: "artwork_hold_budget",
      artworkIds: [a.id],
    });
  });

  it("caps the works one buyer holds at maxCartItems across orders", async () => {
    await patchSetting("checkout", { maxCartItems: 3 });
    const buyer = uniqueBuyer();
    const ipHash = "ip-cart-cap";
    const first = await Promise.all([1, 2].map(() => buyableArtwork(db)));
    await heldCartOrder(
      first.map((w) => w.id),
      { buyer, ipHash },
    );
    const second = await Promise.all([1, 2].map(() => buyableArtwork(db)));
    const { result } = await startCartCheckout(
      second.map((w) => w.id),
      { buyer, ipHash },
    );
    expect(result).toEqual({ kind: "refused", code: "too_many_holds" });
  });
});

describe("cart payment", () => {
  it("a paid cart sells every work: SOLD, one sale each, invariants hold", async () => {
    const works = await Promise.all([1, 2].map(() => buyableArtwork(db)));
    const h = await heldCartOrder(works.map((w) => w.id));
    await clickMockPay(h.ref, "pay");
    expect((await finalize(h.attemptId)).outcome).toBe("paid");
    for (const w of works) expect((await art(w.id)).saleStatus).toBe("SOLD");
    const s = await db.select().from(sales);
    expect(s).toHaveLength(2);
    expect((await order(h.orderId)).status).toBe("PAID");
    const report = await checkInvariants({ graceMinutes: 1_000 });
    expect(
      report.violations.filter((v) => v.check === "paid_order_items_sold"),
    ).toEqual([]);
  });

  it("one work lost before the late payment refunds the whole cart and frees the rest", async () => {
    const a = await buyableArtwork(db);
    const b = await buyableArtwork(db);
    const late = await heldCartOrder([a.id, b.id]);
    await expire(late.orderId, [a.id, b.id]);
    const winner = await heldOrder(b.slug);
    await clickMockPay(winner.ref, "pay");
    expect((await finalize(winner.attemptId)).outcome).toBe("paid");

    await clickMockPay(late.ref, "pay");
    const r = await finalize(late.attemptId);
    expect(r).toMatchObject({
      outcome: "needs_refund",
      orderStatus: "CANCELLED",
    });
    const o = await order(late.orderId);
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, late.attemptId));
    expect(refund).toMatchObject({
      reason: "LOST_RESERVATION",
      amountMinor: o.totalMinor,
    });
    expect((await art(a.id)).reservedByOrderId).toBeNull();
    expect((await art(a.id)).saleStatus).toBe("AVAILABLE");
    expect((await art(b.id)).saleStatus).toBe("SOLD");
  });
});

describe("taken-over carts and overlapping carts", () => {
  it("a takeover of one work releases the expired cart's other works", async () => {
    const a = await buyableArtwork(db);
    const b = await buyableArtwork(db);
    const x = await heldCartOrder([a.id, b.id]);
    await expire(x.orderId, [a.id, b.id]);
    const y = await heldOrder(a.slug);
    expect(await order(x.orderId)).toMatchObject({
      status: "EXPIRED",
      statusReason: "HOLD_TAKEN_OVER",
    });
    expect((await art(a.id)).reservedByOrderId).toBe(y.orderId);
    expect((await art(b.id)).reservedByOrderId).toBeNull();
  });

  it("two buyers with overlapping carts: every order holds all of its works or none", async () => {
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map(() => buyableArtwork(db)),
    );
    if (!a || !b || !c) throw new Error("setup");
    const inputs = await Promise.all([
      cartCheckoutInput([a.id, b.id]),
      cartCheckoutInput([b.id, c.id]),
    ]);
    const results = await race(2, (ctx) =>
      startCheckout(inputs[ctx.index] as (typeof inputs)[number], {
        db: ctx.db,
      }),
    );
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    const redirects = fulfilled.filter((r) => r.result.kind === "redirect");
    expect(redirects).toHaveLength(1);
    const loser = fulfilled.find((r) => r.result.kind !== "redirect");
    expect(loser?.result).toEqual({
      kind: "just_reserved",
      artworkIds: [b.id],
    });
    const rows = await db
      .select()
      .from(artworks)
      .where(inArray(artworks.id, [a.id, b.id, c.id]));
    const winner = redirects[0]?.result;
    if (winner?.kind !== "redirect") throw new Error("no winner");
    for (const row of rows) {
      const ordered = winner.artworkIds.includes(row.id);
      expect(row.reservedByOrderId).toBe(ordered ? winner.orderId : null);
    }
  });
});
