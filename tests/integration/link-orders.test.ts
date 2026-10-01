import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  completeDetails,
  execSql,
  heldOrder,
  insertBuyerRequest,
  linkOrder,
  payOrder,
  testAdminContext,
} from "../helpers/factories/commerce";
import { createMailbox } from "../helpers/mailbox";

/**
 * Link orders (spec §5.8, §5.10, §10.3 `link-orders`): one order held 48 h at a locked price, with
 * the artwork locked first; the buyer completes the details on the order page (a method change
 * requotes); paying extends the hold; payment converts the request; expiry releases the work and
 * expires the request.
 */
const { db } = await import("@/server/db/client");
const { artworks, auditLog, buyerRequests, emailMessages, orders } =
  await import("@/server/db/schema");
const { createLinkOrder } = await import("@/server/checkout/links");
const { expireStaleOrders } = await import("@/server/checkout/release");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { processOutbox } = await import("@/server/outbox/process");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { testDatabaseUrl } = await import("../helpers/db");
const mailbox = createMailbox(testDatabaseUrl());

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

const HOUR = 60 * 60_000;

async function orderOf(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("no order");
  return row;
}
async function artworkOf(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!row) throw new Error("no artwork");
  return row;
}
async function requestOf(id: string) {
  const [row] = await db
    .select()
    .from(buyerRequests)
    .where(eq(buyerRequests.id, id));
  if (!row) throw new Error("no request");
  return row;
}

describe("createLinkOrder", () => {
  it("holds the work 48 h at the locked price and emails the checkout link", async () => {
    const art = await buyableArtwork(db);
    const before = Date.now();
    const link = await linkOrder(art, {
      itemPriceMinor: art.priceIlsMinor ?? 0,
    });
    expect(link.linkUrl).toMatch(/\/en\/orders\/GG-[0-9A-Z]{6}\?k=/);

    const order = await orderOf(link.orderId);
    expect(order).toMatchObject({
      source: "MANUAL",
      status: "AWAITING_PAYMENT",
      currency: "ILS",
      itemsTotalMinor: art.priceIlsMinor,
      totalMinor: art.priceIlsMinor,
      shippingMethod: "LOCAL_PICKUP",
      quoteVersion: 1,
      holdCount: 1,
      conversationTookPlace: true,
      conversationSource: "ADMIN",
    });
    const expires = order.expiresAt?.getTime() ?? 0;
    expect(expires).toBeGreaterThanOrEqual(before + 48 * HOUR - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 48 * HOUR + 1000);
    const held = await artworkOf(art.id);
    expect(held.reservedByOrderId).toBe(order.id);
    expect(held.reservedUntil?.getTime()).toBe(expires);

    for (let i = 0; i < 2; i++) await processOutbox({ limit: 20 });
    const mail = await mailbox.latest({ template: "checkout-link" });
    expect(mail?.toEmail).toBe(order.buyerEmail);
    expect(mail?.text).toContain(order.number);
    expect(mail?.html).toContain(`/en/orders/${order.number}?k=`);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "order.link_created"));
    expect(row?.actor).toBe("admin:u-admin");
  });

  it("the admin may bypass quote-only and price-on-request; a live foreign hold refuses", async () => {
    const quoteOnly = await buyableArtwork(db, {
      quoteOnly: true,
      priceOnRequest: true,
      priceIlsMinor: null,
    });
    const link = await linkOrder(quoteOnly, {
      kind: "QUOTE",
      itemPriceMinor: 900_000,
      lockedShippingMinor: 45_000,
      shippingMethod: "QUOTED",
    });
    const order = await orderOf(link.orderId);
    expect(order).toMatchObject({
      source: "QUOTE",
      shippingMethod: "QUOTED",
      shippingLocked: true,
      shippingMinor: 45_000,
      totalMinor: 945_000,
    });

    const busy = await buyableArtwork(db);
    await heldOrder(busy.slug);
    await expect(linkOrder(busy)).rejects.toMatchObject({
      code: "ARTWORK_NOT_RESERVABLE",
    });
  });

  it("a price other than the list price needs a reason (offers are exempt); IL pays in ILS", async () => {
    const art = await buyableArtwork(db);
    await expect(
      linkOrder(art, { itemPriceMinor: 120_000 }),
    ).rejects.toMatchObject({ code: "PRICE_CHANGE_REASON_REQUIRED" });
    const ok = await linkOrder(art, {
      itemPriceMinor: 120_000,
      priceChangeReason: "Studio discount agreed by phone",
    });
    expect((await orderOf(ok.orderId)).adminNotes).toContain("Studio discount");

    const other = await buyableArtwork(db);
    await expect(
      linkOrder(other, { currency: "USD", country: "IL" }),
    ).rejects.toMatchObject({ code: "IL_REQUIRES_ILS" });
    // Nothing was written by the refused calls.
    expect((await artworkOf(other.id)).reservedByOrderId).toBeNull();
  });

  it("an engine price is required unless the admin locks the shipping", async () => {
    const tube = await buyableArtwork(db, { quoteOnly: true });
    await expect(
      linkOrder(tube, { kind: "QUOTE", shippingMethod: "CARRIER_TABLE" }),
    ).rejects.toMatchObject({ code: "SHIPPING_QUOTE_REQUIRED" });
  });
});

describe("paying a link order", () => {
  it("is refused until the buyer completes the details; paying extends the hold to ≥ now+35 min", async () => {
    const art = await buyableArtwork(db);
    const link = await linkOrder(art, { expiresInHours: 2 });
    const refused = await payOrder(link.orderId);
    expect(refused.result).toEqual({
      kind: "refused",
      code: "details_required",
    });

    const saved = await completeDetails(link.orderId, {
      method: "LOCAL_PICKUP",
    });
    expect(saved).toMatchObject({ kind: "saved", totalChanged: false });

    // Five minutes left on the link hold: "Pay" extends it, never shortens it.
    await execSql(
      `UPDATE artworks SET reserved_until = now() + interval '5 minutes' WHERE id = $1`,
      [art.id],
    );
    await execSql(
      `UPDATE orders SET expires_at = now() + interval '5 minutes' WHERE id = $1`,
      [link.orderId],
    );
    const paid = await payOrder(link.orderId);
    expect(paid.result.kind).toBe("redirect");
    const until = (await artworkOf(art.id)).reservedUntil?.getTime() ?? 0;
    expect(until).toBeGreaterThan(Date.now() + 34 * 60_000);
    expect((await orderOf(link.orderId)).expiresAt?.getTime()).toBe(until);

    await clickMockPay(paid.attempt?.providerRef ?? "", "pay");
    const { result } = await finalizeAttempt(paid.attempt?.id ?? "", {
      trigger: "return",
    });
    expect(result.outcome).toBe("paid");
    expect((await artworkOf(art.id)).saleStatus).toBe("SOLD");
  });

  it("a method change requotes (quote version bump); a locked shipping cannot change", async () => {
    const art = await buyableArtwork(db);
    const link = await linkOrder(art);
    const before = await orderOf(link.orderId);
    const saved = await completeDetails(link.orderId, {
      method: "CARRIER_TABLE",
    });
    expect(saved).toMatchObject({ kind: "saved", totalChanged: true });
    const after = await orderOf(link.orderId);
    expect(after.quoteVersion).toBe(before.quoteVersion + 1);
    expect(after.shippingMethod).toBe("CARRIER_TABLE");
    expect(after.totalMinor).toBe(
      after.itemsTotalMinor + after.shippingMinor + after.insuranceMinor,
    );
    expect(after.shipLine1).toBe("1 Test Street");

    const other = await buyableArtwork(db);
    const locked = await linkOrder(other, {
      lockedShippingMinor: 0,
      shippingMethod: "ARTIST_DELIVERY",
    });
    expect(
      await completeDetails(locked.orderId, { method: "CARRIER_TABLE" }),
    ).toEqual({ kind: "refused", code: "method_locked" });
  });

  it("abroad: DAP acknowledgement and a Latin address are required; USD at the locked price", async () => {
    const art = await buyableArtwork(db);
    const link = await linkOrder(art, {
      country: "US",
      currency: "USD",
      itemPriceMinor: art.priceUsdMinor ?? 0,
      shippingMethod: "CARRIER_TABLE",
    });
    const order = await orderOf(link.orderId);
    expect(order).toMatchObject({ currency: "USD", shipCountry: "US" });
    expect(
      await completeDetails(link.orderId, { country: "US", duties: false }),
    ).toEqual({ kind: "refused", code: "duties_ack_required" });
    const ok = await completeDetails(link.orderId, { country: "US" });
    expect(ok.kind).toBe("saved");
    expect((await payOrder(link.orderId)).result.kind).toBe("redirect");
  });
});

describe("the request behind the link", () => {
  it("a quote request becomes QUOTED, then CONVERTED when the order is paid", async () => {
    const art = await buyableArtwork(db);
    const req = await insertBuyerRequest(db, { artworkId: art.id });
    const link = await linkOrder(art, {
      kind: "QUOTE",
      requestId: req.id,
      conversationTookPlace: false,
    });
    expect(await requestOf(req.id)).toMatchObject({
      status: "QUOTED",
      orderId: link.orderId,
    });
    // The request itself is the conversation source.
    expect(await orderOf(link.orderId)).toMatchObject({
      conversationTookPlace: true,
      conversationSource: `REQUEST:${req.id}`,
    });
    await expect(
      linkOrder(await buyableArtwork(db), { requestId: req.id }),
    ).rejects.toMatchObject({ code: "REQUEST_ALREADY_LINKED" });

    await completeDetails(link.orderId, { method: "LOCAL_PICKUP" });
    const { attempt } = await payOrder(link.orderId);
    await clickMockPay(attempt?.providerRef ?? "", "pay");
    await finalizeAttempt(attempt?.id ?? "", { trigger: "webhook" });
    expect((await orderOf(link.orderId)).status).toBe("PAID");
    expect((await requestOf(req.id)).status).toBe("CONVERTED");
  });

  it("an offer at the asked amount is ACCEPTED; another amount is COUNTERED", async () => {
    const a = await buyableArtwork(db);
    const offerA = await insertBuyerRequest(db, {
      kind: "OFFER",
      artworkId: a.id,
      offerAmountMinor: 130_000,
      offerCurrency: "ILS",
    });
    await linkOrder(a, {
      kind: "OFFER",
      requestId: offerA.id,
      itemPriceMinor: 130_000,
    });
    expect((await requestOf(offerA.id)).status).toBe("ACCEPTED");

    const b = await buyableArtwork(db);
    const offerB = await insertBuyerRequest(db, {
      kind: "OFFER",
      artworkId: b.id,
      offerAmountMinor: 100_000,
      offerCurrency: "ILS",
    });
    await linkOrder(b, {
      kind: "OFFER",
      requestId: offerB.id,
      itemPriceMinor: 140_000,
    });
    expect((await requestOf(offerB.id)).status).toBe("COUNTERED");
  });

  it("expiry: the order becomes EXPIRED (LINK_EXPIRED), the work is free, the request EXPIRED", async () => {
    const art = await buyableArtwork(db);
    const req = await insertBuyerRequest(db, { artworkId: art.id });
    const link = await linkOrder(art, { kind: "QUOTE", requestId: req.id });
    await execSql(
      `UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
      [art.id],
    );
    await execSql(
      `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [link.orderId],
    );
    const { result } = await expireStaleOrders({
      limit: 10,
      deadline: Date.now() + 10_000,
    });
    expect(result.expired).toBe(1);
    expect(await orderOf(link.orderId)).toMatchObject({
      status: "EXPIRED",
      statusReason: "LINK_EXPIRED",
    });
    expect((await artworkOf(art.id)).reservedByOrderId).toBeNull();
    expect((await requestOf(req.id)).status).toBe("EXPIRED");
  });

  it("a lapsed link hold taken over by a web buyer expires the order and its request", async () => {
    const art = await buyableArtwork(db);
    const req = await insertBuyerRequest(db, { artworkId: art.id });
    const link = await linkOrder(art, { kind: "QUOTE", requestId: req.id });
    await execSql(
      `UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
      [art.id],
    );
    const web = await heldOrder(art.slug);
    expect((await artworkOf(art.id)).reservedByOrderId).toBe(web.orderId);
    expect(await orderOf(link.orderId)).toMatchObject({
      status: "EXPIRED",
      statusReason: "HOLD_TAKEN_OVER",
    });
    expect((await requestOf(req.id)).status).toBe("EXPIRED");
  });
});

describe("guards", () => {
  it("the email rows never carry another buyer's data (one link email per order)", async () => {
    const art = await buyableArtwork(db);
    const link = await linkOrder(art);
    for (let i = 0; i < 3; i++) await processOutbox({ limit: 20 });
    const rows = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, link.orderId));
    expect(rows.map((r) => r.template)).toEqual(["checkout-link"]);
  });

  it("createLinkOrder needs an admin context (the type) and records its actor", async () => {
    const art = await buyableArtwork(db);
    const ctx = testAdminContext({ actor: "admin:other" });
    const { result } = await createLinkOrder(
      {
        kind: "MANUAL",
        artworkId: art.id,
        buyer: { name: "A Buyer", email: "a@example.test", phone: "" },
        country: "IL",
        currency: "ILS",
        itemPriceMinor: art.priceIlsMinor ?? 0,
        conversationTookPlace: false,
        locale: "he",
      },
      ctx,
    );
    const order = await orderOf(result.orderId);
    // No method given: the first table method for Israel (the courier).
    expect(order.shippingMethod).toBe("CARRIER_TABLE");
    expect(order.conversationTookPlace).toBe(false);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, order.id));
    expect(row?.actor).toBe("admin:other");
  });
});
