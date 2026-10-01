import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  checkoutInput,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { partition, race } from "../helpers/race";

/**
 * Spec §10.3 `capture-race`: the re-entrant capture claim. Parallel finalizes capture once; a
 * claim that finds the work gone cancels without capturing; a capture timeout keeps the hold in
 * flight (no takeover) until reconcile re-enters and captures with the same key; the capture
 * watch cancels; review → COMPLETED / DENIED (hold shortened to ≤ 35 min).
 */
const { db } = await import("@/server/db/client");
const {
  adminAlerts,
  artworks,
  mockPayments,
  orders,
  outboxJobs,
  paymentAttempts,
} = await import("@/server/db/schema");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { startCheckout, startPaymentForOrder } = await import(
  "@/server/checkout/start"
);
const { mockProviderHooks, resetMockProviderHooks, resolveMockReview } =
  await import("@/server/payments/providers/mock");

cleanDatabaseBeforeEach();
beforeEach(() => {
  resetMockProviderHooks();
});

const finalize = (
  id: string,
  trigger: "webhook" | "return" | "reconcile" | "admin" = "webhook",
) => finalizeAttempt(id, { trigger }).then((r) => r.result);

async function captureOrder(slug: string) {
  mockProviderHooks.nextFlow = "CAPTURE";
  const h = await heldOrder(slug);
  await clickMockPay(h.ref, "pay"); // capture flow: approve only
  return h;
}
async function attempt(id: string) {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, id));
  if (!row) throw new Error("attempt");
  return row;
}
async function order(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order");
  return row;
}
async function artwork(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!row) throw new Error("artwork");
  return row;
}
async function mock(ref: string) {
  const [row] = await db
    .select()
    .from(mockPayments)
    .where(eq(mockPayments.ref, ref));
  if (!row) throw new Error("mock");
  return row;
}

describe("capture race", () => {
  it("parallel finalizes capture exactly once", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    expect((await mock(h.ref)).state).toBe("APPROVED");
    const results = await race(6, (c) =>
      finalizeAttempt(h.attemptId, { trigger: "webhook", db: c.db }),
    );
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    const outcomes = fulfilled.map((r) => r.result.outcome);
    expect(outcomes.filter((o) => o === "paid")).toHaveLength(1);
    expect(mockProviderHooks.calls.capture).toBe(1);
    expect((await mock(h.ref)).captureRequestIds).toHaveLength(1);
    expect((await order(h.orderId)).status).toBe("PAID");
  });

  it("a claim that finds the work gone cancels without capturing", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    const other = await heldOrder(art.slug);
    await clickMockPay(other.ref, "pay");
    expect((await finalize(other.attemptId)).outcome).toBe("paid");

    const r = await finalize(h.attemptId);
    expect(r).toMatchObject({
      outcome: "lost_before_capture",
      attemptStatus: "CANCELED",
    });
    expect(mockProviderHooks.calls.capture).toBe(0);
    expect((await mock(h.ref)).state).toBe("APPROVED");
    const jobs = await db
      .select({ key: outboxJobs.dedupeKey })
      .from(outboxJobs);
    expect(
      jobs.some((j) =>
        j.key.startsWith(`email:purchase-not-completed:${h.attemptId}`),
      ),
    ).toBe(true);
  });

  it("a stale quote cancels the capture claim with nothing captured", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    await execSql(
      "UPDATE orders SET quote_version = quote_version + 1 WHERE id = $1",
      [h.orderId],
    );
    const r = await finalize(h.attemptId);
    expect(r).toMatchObject({ outcome: "canceled", attemptStatus: "CANCELED" });
    expect(mockProviderHooks.calls.capture).toBe(0);
  });

  it("capture timeout → 15 min → no takeover → reconcile re-enters and captures with the same key", async () => {
    const art = await buyableArtwork(db);
    const late = await checkoutInput(art.slug);
    const h = await captureOrder(art.slug);
    mockProviderHooks.captureTimeout = { applied: false };
    expect((await finalize(h.attemptId)).outcome).toBe("capturing");
    const claimed = await attempt(h.attemptId);
    expect(claimed.status).toBe("CAPTURING");
    const key = claimed.captureRequestId;
    expect(key).not.toBeNull();

    // 15 minutes pass: the hold's time is up, but the payment is in flight.
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '5 minutes' WHERE id = $1",
      [art.id],
    );
    await execSql(
      "UPDATE orders SET expires_at = now() - interval '5 minutes' WHERE id = $1",
      [h.orderId],
    );
    await execSql(
      "UPDATE payment_attempts SET last_checked_at = now() - interval '15 minutes' WHERE id = $1",
      [h.attemptId],
    );
    const second = await startCheckout(late);
    expect(second.result.kind).toBe("just_reserved");
    expect((await artwork(art.id)).reservedByOrderId).toBe(h.orderId);

    // A webhook within the re-entry window does not re-capture; reconcile does, with the same key.
    const r = await finalize(h.attemptId, "reconcile");
    expect(r.outcome).toBe("paid");
    expect(mockProviderHooks.calls.capture).toBe(2);
    expect((await mock(h.ref)).captureRequestIds).toEqual([key]);
    const done = await attempt(h.attemptId);
    expect(done.captureRequestId).toBe(key);
    expect(done.captureTries).toBe(2);
  });

  it("a capture whose response was lost is found by the GET on re-entry (no second capture)", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    mockProviderHooks.captureTimeout = { applied: true };
    expect((await finalize(h.attemptId)).outcome).toBe("capturing");
    expect((await mock(h.ref)).state).toBe("PAID");
    const r = await finalize(h.attemptId, "reconcile");
    expect(r.outcome).toBe("paid");
    expect(mockProviderHooks.calls.capture).toBe(1);
  });

  it("the capture watch cancels after 6 tries and releases the hold", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    mockProviderHooks.captureTimeout = { applied: false };
    await finalize(h.attemptId);
    await execSql(
      "UPDATE payment_attempts SET capture_tries = 6 WHERE id = $1",
      [h.attemptId],
    );
    const r = await finalize(h.attemptId, "reconcile");
    expect(r).toMatchObject({ outcome: "canceled", attemptStatus: "CANCELED" });
    const a = await artwork(art.id);
    expect(a.reservedUntil && a.reservedUntil.getTime() <= Date.now()).toBe(
      true,
    );
    const alerts = await db.select().from(adminAlerts);
    expect(
      alerts.some(
        (x) => x.kind === "CAPTURE_WATCH_EXPIRED" && x.severity === "CRITICAL",
      ),
    ).toBe(true);
  });

  it("review → COMPLETED: PAYMENT_REVIEW with a 7-day hold, then PAID", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    mockProviderHooks.captureReview = true;
    const r = await finalize(h.attemptId);
    expect(r).toMatchObject({
      outcome: "review",
      attemptStatus: "PAYMENT_REVIEW",
      orderStatus: "PAYMENT_REVIEW",
    });
    const o = await order(h.orderId);
    expect(o.fulfillmentBlockedReason).toBe("PAYMENT_REVIEW");
    const a = await artwork(art.id);
    expect((a.reservedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60_000,
    );
    const jobs = await db
      .select({ key: outboxJobs.dedupeKey })
      .from(outboxJobs);
    expect(jobs.some((j) => j.key.startsWith("email:payment-review:"))).toBe(
      true,
    );
    // New attempts and releases are refused while in review.
    const pay = await startPaymentForOrder({
      orderId: h.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: null,
    });
    expect(pay.result).toEqual({ kind: "refused", code: "not_payable" });

    expect((await finalize(h.attemptId, "reconcile")).outcome).toBe("review");
    await resolveMockReview(h.ref, "PAID");
    expect((await finalize(h.attemptId, "reconcile")).outcome).toBe("paid");
    const paid = await order(h.orderId);
    expect(paid.status).toBe("PAID");
    expect(paid.fulfillmentBlockedReason).toBeNull();
  });

  it("review → DENIED: attempt FAILED, order awaiting payment, hold shortened to ≤ 35 min", async () => {
    const art = await buyableArtwork(db);
    const h = await captureOrder(art.slug);
    mockProviderHooks.captureReview = true;
    await finalize(h.attemptId);
    await resolveMockReview(h.ref, "DECLINED");
    const r = await finalize(h.attemptId, "reconcile");
    expect(r).toMatchObject({
      outcome: "failed",
      attemptStatus: "FAILED",
      orderStatus: "AWAITING_PAYMENT",
    });
    const a = await artwork(art.id);
    const left = (a.reservedUntil?.getTime() ?? 0) - Date.now();
    expect(left).toBeLessThanOrEqual(35 * 60_000 + 5_000);
    expect(left).toBeGreaterThan(30 * 60_000);
    expect((await order(h.orderId)).fulfillmentBlockedReason).toBeNull();
  });
});
