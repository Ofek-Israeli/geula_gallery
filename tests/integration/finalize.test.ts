import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { mockWebhookBody, signMockWebhook } from "../helpers/mock-webhook";
import { partition, race } from "../helpers/race";

/**
 * Spec §10.3 `finalize`: the one idempotent finalizer. Normal success, 10 concurrent finalizes,
 * webhook ×3 plus the return route, late payments (free → PAID, taken → refund + receipt + credit
 * note), duplicates, cancelled orders, mismatches, config drift, stale quotes, deferral while
 * another attempt is capturing, provider-side refunds, and unpublished-but-free late payments.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const {
  adminAlerts,
  artworks,
  orders,
  outboxJobs,
  paymentAttempts,
  paymentEvents,
  refunds,
  sales,
  shipments,
} = schema;
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { handlePaymentReturn, handlePaymentWebhook } = await import(
  "@/server/payments/webhook"
);
const { startPaymentForOrder } = await import("@/server/checkout/start");
const { requoteOrder, shippingQuoteForOrder } = await import(
  "@/server/checkout/requote"
);
const { expireStaleOrders } = await import("@/server/checkout/release");
const { withTx } = await import("@/server/db/tx");
const { executeRefund, settleRefund } = await import(
  "@/server/payments/refunds"
);
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { hmacToken } = await import("@/server/security/tokens");

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

const finalize = (
  attemptId: string,
  trigger: "webhook" | "return" | "reconcile" | "admin" = "return",
) => finalizeAttempt(attemptId, { trigger }).then((r) => r.result);

async function order(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order missing");
  return row;
}
async function attempt(id: string) {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, id));
  if (!row) throw new Error("attempt missing");
  return row;
}
async function artwork(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!row) throw new Error("artwork missing");
  return row;
}
async function jobKeys() {
  const rows = await db
    .select({ key: outboxJobs.dedupeKey, kind: outboxJobs.kind })
    .from(outboxJobs);
  return rows.map((r) => r.key).sort();
}
async function alertKinds() {
  const rows = await db
    .select({ kind: adminAlerts.kind, severity: adminAlerts.severity })
    .from(adminAlerts);
  return rows;
}
async function expireHold(orderId: string, artworkId: string) {
  await execSql(
    "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
    [artworkId],
  );
  await execSql(
    "UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1",
    [orderId],
  );
}

describe("finalizeAttempt", () => {
  it("applies a verified success: SOLD, sale, PAID, shipment and one job set", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    expect((await finalize(h.attemptId)).outcome).toBe("pending");
    await clickMockPay(h.ref, "pay");
    const r = await finalize(h.attemptId);
    expect(r).toMatchObject({
      outcome: "paid",
      attemptStatus: "SUCCEEDED",
      orderStatus: "PAID",
    });

    const a = await artwork(art.id);
    expect(a.saleStatus).toBe("SOLD");
    expect(a.reservedByOrderId).toBeNull();
    const s = await db.select().from(sales);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      channel: "ONLINE",
      isMock: true,
      orderId: h.orderId,
    });
    const o = await order(h.orderId);
    expect(o.paidAttemptId).toBe(h.attemptId);
    const att = await attempt(h.attemptId);
    expect(att.transactionId).toMatch(/^mocktx_/);
    expect(att.cardLast4).toBe("4242");
    expect(await db.select().from(shipments)).toHaveLength(1);
    const keys = await jobKeys();
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.startsWith("email:order-confirmation:"))).toBe(
      true,
    );
    expect(keys.some((k) => k.startsWith("email:painter-new-order:"))).toBe(
      true,
    );
    expect(keys).toContain(`taxdoc:receipt:${h.attemptId}`);
    // Idempotent.
    expect((await finalize(h.attemptId, "admin")).outcome).toBe(
      "already_final",
    );
  });

  it("10 concurrent finalizes produce one sale and one job set", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    const results = await race(10, (c) =>
      finalizeAttempt(h.attemptId, { trigger: "webhook", db: c.db }),
    );
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    const outcomes = fulfilled.map((r) => r.result.outcome).sort();
    expect(outcomes.filter((o) => o === "paid")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_final")).toHaveLength(9);
    expect(await db.select().from(sales)).toHaveLength(1);
    expect(await jobKeys()).toHaveLength(3);
  });

  it("webhook ×3 plus the return route: one processing, duplicates acknowledged", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    const secret = process.env.MOCK_WEBHOOK_SECRET ?? "";
    const body = mockWebhookBody(h.ref);
    const send = (raw: string) =>
      handlePaymentWebhook({
        provider: "mock",
        headers: new Headers({
          "x-mock-signature": signMockWebhook(raw, secret),
        }),
        rawBody: raw,
        query: new URLSearchParams(),
        ip: "203.0.113.5",
      });
    const first = await send(body);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("paid");
    expect((await send(body)).body).toMatchObject({ duplicate: true });
    expect((await send(body)).body).toMatchObject({ duplicate: true });
    const events = await db.select().from(paymentEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      receivedCount: 3,
      outcome: "paid",
      attemptId: h.attemptId,
    });
    expect(events[0]?.processedAt).not.toBeNull();

    const back = await handlePaymentReturn({
      provider: "mock",
      query: new URLSearchParams({
        a: h.attemptId,
        r: hmacToken("return", h.attemptId),
        l: "en",
        s: "success",
      }),
      ip: "203.0.113.5",
    });
    expect(back.status).toBe(303);
    expect(back.location).toContain("payment=paid");
    expect(back.location).toContain("/en/orders/");
    expect(await db.select().from(sales)).toHaveLength(1);

    // Forged: 401 and nothing recorded.
    const forged = await handlePaymentWebhook({
      provider: "mock",
      headers: new Headers({
        "x-mock-signature": signMockWebhook(body, "wrong-secret-0123456789"),
      }),
      rawBody: mockWebhookBody(h.ref),
      query: new URLSearchParams(),
      ip: "203.0.113.9",
    });
    expect(forged.status).toBe(401);
    expect(await db.select().from(paymentEvents)).toHaveLength(1);

    // A bad return token goes to the generic "returned" page.
    const bad = await handlePaymentReturn({
      provider: "mock",
      query: new URLSearchParams({
        a: h.attemptId,
        r: "x".repeat(32),
        l: "he",
      }),
      ip: "203.0.113.5",
    });
    expect(bad.location).toMatch(/\/he\/checkout\/returned$/);
  });

  it("a webhook whose processing fails answers 500 and keeps the event unprocessed", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    const { mockProviderHooks } = await import(
      "@/server/payments/providers/mock"
    );
    mockProviderHooks.fetchTimeout = true;
    const secret = process.env.MOCK_WEBHOOK_SECRET ?? "";
    const raw = mockWebhookBody(h.ref);
    const send = () =>
      handlePaymentWebhook({
        provider: "mock",
        headers: new Headers({
          "x-mock-signature": signMockWebhook(raw, secret),
        }),
        rawBody: raw,
        query: new URLSearchParams(),
        ip: "203.0.113.5",
      });
    expect((await send()).status).toBe(500);
    const [event] = await db.select().from(paymentEvents);
    expect(event?.processedAt).toBeNull();
    expect(event?.lastError).toContain("unknown");
    const redelivered = await send();
    expect(redelivered.status).toBe(200);
    expect(redelivered.body.outcome).toBe("paid");
  });

  it("a late success while the work is still free → PAID (INFO alert)", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await expireHold(h.orderId, art.id);
    await expireStaleOrders({ limit: 10, deadline: Date.now() + 10_000 });
    expect((await order(h.orderId)).status).toBe("EXPIRED");
    await clickMockPay(h.ref, "pay");
    expect((await finalize(h.attemptId, "webhook")).outcome).toBe("paid");
    expect((await order(h.orderId)).status).toBe("PAID");
    expect((await alertKinds()).map((a) => a.kind)).toContain(
      "LATE_PAYMENT_APPLIED",
    );
  });

  it("an unpublished but free work still accepts a late payment", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await expireHold(h.orderId, art.id);
    await db
      .update(artworks)
      .set({ isPublished: false })
      .where(eq(artworks.id, art.id));
    await clickMockPay(h.ref, "pay");
    expect((await finalize(h.attemptId)).outcome).toBe("paid");
    expect((await artwork(art.id)).saleStatus).toBe("SOLD");
  });

  it("a late success after the work was sold → LOST_RESERVATION refund, receipt and credit note", async () => {
    const art = await buyableArtwork(db);
    const late = await heldOrder(art.slug);
    await expireHold(late.orderId, art.id);
    const winner = await heldOrder(art.slug);
    expect((await order(late.orderId)).statusReason).toBe("HOLD_TAKEN_OVER");
    await clickMockPay(winner.ref, "pay");
    expect((await finalize(winner.attemptId)).outcome).toBe("paid");

    await clickMockPay(late.ref, "pay");
    const r = await finalize(late.attemptId, "webhook");
    expect(r).toMatchObject({
      outcome: "needs_refund",
      attemptStatus: "NEEDS_REFUND",
      orderStatus: "CANCELLED",
    });
    const o = await order(late.orderId);
    expect(o.statusReason).toBe("LOST_RESERVATION");
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, late.attemptId));
    expect(refund).toMatchObject({
      reason: "LOST_RESERVATION",
      status: "REQUESTED",
      amountMinor: o.totalMinor,
    });
    expect(refund?.legalDueAt).not.toBeNull();
    const keys = await jobKeys();
    expect(keys).toContain(`taxdoc:receipt:${late.attemptId}`);
    expect(keys).toContain(`refund:${refund?.id}`);
    expect(
      keys.some((k) =>
        k.startsWith(`email:purchase-not-completed:${late.attemptId}`),
      ),
    ).toBe(true);
    expect(
      (await alertKinds()).some(
        (a) => a.kind === "PAYMENT_NEEDS_REFUND" && a.severity === "CRITICAL",
      ),
    ).toBe(true);

    // The refund runs and settles: attempt REFUNDED, credit note queued, refund-issued email.
    const exec = await executeRefund(refund?.id ?? "");
    expect(exec.result.status).toBe("SUCCEEDED");
    await settleRefund(refund?.id ?? "");
    expect((await attempt(late.attemptId)).status).toBe("REFUNDED");
    const after = await jobKeys();
    expect(after).toContain(`taxdoc:credit-note:${refund?.id}`);
    expect(
      after.some((k) => k.startsWith(`email:refund-issued:${refund?.id}`)),
    ).toBe(true);
    // The winner is untouched.
    expect((await order(winner.orderId)).status).toBe("PAID");
    expect(await db.select().from(sales)).toHaveLength(1);
  });

  it("a second paid attempt of a paid order → DUPLICATE_PAYMENT refund", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    const { result } = await startPaymentForOrder({
      orderId: h.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: h.input.ipHash,
    });
    expect(result.kind).toBe("redirect");
    const [second] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, h.orderId), eq(paymentAttempts.seq, 2)),
      );
    if (!second?.providerRef) throw new Error("no second attempt");
    await clickMockPay(second.providerRef, "pay");
    await clickMockPay(h.ref, "pay");
    expect((await finalize(second.id)).outcome).toBe("paid");
    const dup = await finalize(h.attemptId);
    expect(dup.outcome).toBe("needs_refund");
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, h.attemptId));
    expect(refund?.reason).toBe("DUPLICATE_PAYMENT");
    expect((await order(h.orderId)).status).toBe("PAID");
  });

  it("a payment for a cancelled order → ORDER_CANCELLED refund", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await execSql(
      "UPDATE artworks SET reserved_by_order_id = NULL, reserved_until = NULL WHERE id = $1",
      [art.id],
    );
    await execSql(
      "UPDATE orders SET status = 'CANCELLED', status_reason = 'ADMIN' WHERE id = $1",
      [h.orderId],
    );
    await clickMockPay(h.ref, "pay");
    expect((await finalize(h.attemptId)).outcome).toBe("needs_refund");
    const [refund] = await db.select().from(refunds);
    expect(refund?.reason).toBe("ORDER_CANCELLED");
  });

  it("an amount mismatch → MANUAL_REQUIRED refund with a deadline, never paid", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE mock_payments SET amount_minor = amount_minor - 100 WHERE ref = $1",
      [h.ref],
    );
    const r = await finalize(h.attemptId);
    expect(r.outcome).toBe("needs_refund");
    expect(r.orderStatus).toBe("AWAITING_PAYMENT");
    const [refund] = await db.select().from(refunds);
    expect(refund).toMatchObject({
      reason: "AMOUNT_MISMATCH",
      status: "MANUAL_REQUIRED",
    });
    expect(refund?.amountMinor).toBe((await order(h.orderId)).totalMinor - 100);
    expect(refund?.legalDueAt).not.toBeNull();
    const keys = await jobKeys();
    expect(keys.some((k) => k.startsWith("refund:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("taxdoc:receipt:"))).toBe(false);
    expect((await artwork(art.id)).saleStatus).toBe("AVAILABLE");
    expect(
      (await alertKinds()).some(
        (a) => a.kind === "PAYMENT_NEEDS_REFUND" && a.severity === "CRITICAL",
      ),
    ).toBe(true);
  });

  it("a mismatch without money taken (approval only) → FAILED", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "approve");
    await execSql(
      "UPDATE mock_payments SET amount_minor = amount_minor + 100 WHERE ref = $1",
      [h.ref],
    );
    const r = await finalize(h.attemptId);
    expect(r).toMatchObject({ outcome: "failed", attemptStatus: "FAILED" });
    expect(await db.select().from(refunds)).toHaveLength(0);
  });

  it("config drift is refused with a CRITICAL alert", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE payment_attempts SET merchant_ref = 'another-merchant' WHERE id = $1",
      [h.attemptId],
    );
    expect((await finalize(h.attemptId)).outcome).toBe("config_drift");
    expect((await alertKinds()).map((a) => a.kind)).toContain("CONFIG_DRIFT");
    expect((await order(h.orderId)).status).toBe("AWAITING_PAYMENT");
  });

  it("stale quote: the old attempt paid after a requote → STALE_QUOTE refund, order still awaiting", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug); // LOCAL_PICKUP
    const shipping = await shippingQuoteForOrder(h.orderId, {
      method: "ARTIST_DELIVERY",
    });
    expect(shipping.mode).toBe("ok");
    const requoted = await withTx((tx) =>
      requoteOrder(tx, h.orderId, shipping),
    );
    expect(requoted).toMatchObject({ changed: true, quoteVersion: 2 });
    const next = await startPaymentForOrder({
      orderId: h.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: h.input.ipHash,
    });
    expect(next.result.kind).toBe("redirect");

    await clickMockPay(h.ref, "pay");
    const stale = await finalize(h.attemptId);
    expect(stale).toMatchObject({
      outcome: "needs_refund",
      orderStatus: "AWAITING_PAYMENT",
    });
    const [refund] = await db.select().from(refunds);
    expect(refund?.reason).toBe("STALE_QUOTE");
    expect((await artwork(art.id)).saleStatus).toBe("AVAILABLE");

    const [second] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, h.orderId), eq(paymentAttempts.seq, 2)),
      );
    expect(second?.quoteVersion).toBe(2);
    await clickMockPay(second?.providerRef ?? "", "pay");
    expect((await finalize(second?.id ?? "")).outcome).toBe("paid");
    expect((await order(h.orderId)).shippingMinor).toBe(shipping.shippingMinor);
    expect((await order(h.orderId)).shippingMethod).toBe("ARTIST_DELIVERY");
  });

  it("defers a success while another attempt of the order is capturing", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await startPaymentForOrder({
      orderId: h.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: h.input.ipHash,
    });
    const [second] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, h.orderId), eq(paymentAttempts.seq, 2)),
      );
    await execSql(
      "UPDATE payment_attempts SET status = 'CAPTURING', capture_request_id = gen_random_uuid(), capturing_since = now() WHERE id = $1",
      [second?.id],
    );
    await clickMockPay(h.ref, "pay");
    const before = Date.now();
    const r = await finalize(h.attemptId, "webhook");
    expect(r).toMatchObject({
      outcome: "deferred",
      attemptStatus: "PENDING",
      orderStatus: "AWAITING_PAYMENT",
    });
    const att = await attempt(h.attemptId);
    expect(att.nextCheckAt?.getTime()).toBeGreaterThan(before + 14 * 60_000);
    expect((await alertKinds()).map((a) => a.kind)).toContain(
      "PAYMENT_DEFERRED",
    );

    await execSql(
      "UPDATE payment_attempts SET status = 'CANCELED' WHERE id = $1",
      [second?.id],
    );
    expect((await finalize(h.attemptId, "reconcile")).outcome).toBe("paid");
  });

  it("refunded at the provider before we finalized → EXTERNAL refund, attempt REFUNDED", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE mock_payments SET state = 'REFUNDED', refunded_minor = amount_minor WHERE ref = $1",
      [h.ref],
    );
    const r = await finalize(h.attemptId);
    expect(r).toMatchObject({
      outcome: "refunded",
      attemptStatus: "REFUNDED",
      orderStatus: "AWAITING_PAYMENT",
    });
    const [refund] = await db.select().from(refunds);
    expect(refund).toMatchObject({ reason: "EXTERNAL", status: "SUCCEEDED" });
  });

  it("partially refunded at the provider → EXTERNAL row, then applied as a success with a CRITICAL alert", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE mock_payments SET state = 'PARTIALLY_REFUNDED', refunded_minor = 10000 WHERE ref = $1",
      [h.ref],
    );
    const r = await finalize(h.attemptId);
    expect(r.outcome).toBe("paid");
    const [refund] = await db.select().from(refunds);
    expect(refund).toMatchObject({
      reason: "EXTERNAL",
      status: "SUCCEEDED",
      amountMinor: 10000,
    });
    expect((await alertKinds()).map((a) => a.kind)).toContain(
      "PAYMENT_PARTIALLY_REFUNDED",
    );
  });

  it("declined and cancelled payments end the attempt; the hold stays until its TTL", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "decline");
    expect((await finalize(h.attemptId)).outcome).toBe("failed");
    expect((await artwork(art.id)).reservedByOrderId).toBe(h.orderId);
    const again = await startPaymentForOrder({
      orderId: h.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: h.input.ipHash,
    });
    expect(again.result.kind).toBe("redirect");
    const [second] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(eq(paymentAttempts.orderId, h.orderId), eq(paymentAttempts.seq, 2)),
      );
    await clickMockPay(second?.providerRef ?? "", "cancel");
    expect((await finalize(second?.id ?? "")).outcome).toBe("canceled");
  });

  it("an old pending mock attempt expires after its watch window", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await execSql(
      "UPDATE payment_attempts SET created_at = now() - interval '2 hours' WHERE id = $1",
      [h.attemptId],
    );
    expect((await finalize(h.attemptId, "reconcile")).outcome).toBe("expired");
    expect((await attempt(h.attemptId)).status).toBe("EXPIRED");
    // A late payment of the expired attempt is still applied.
    await clickMockPay(h.ref, "pay");
    expect((await finalize(h.attemptId)).outcome).toBe("paid");
  });
});
