import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
  insertBuyerRequest,
  linkOrder,
} from "../helpers/factories/commerce";

/**
 * Expiry, tail and sweep (spec §5.3 #2, #10, #15, §5.11, §10.3 `expire-job`): reconcile releases
 * lapsed holds but never one whose payment is in flight; link requests expire with their order;
 * a Cardcom attempt that expired unpaid is polled daily for 30 days; the live ListTransactions
 * sweep finalizes matched-but-unapplied payments and raises a CRITICAL alert for money it cannot
 * place.
 */
const { db } = await import("@/server/db/client");
const { adminAlerts, artworks, buyerRequests, orders, paymentAttempts } =
  await import("@/server/db/schema");
const { runCronJob } = await import("@/server/jobs");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { setProviderFactoryForTests } = await import(
  "@/server/payments/registry"
);
const { pollCardcomTail, sweepCardcomTransactions } = await import(
  "@/server/payments/sweep"
);
const { mockProviderHooks, resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
type Provider = import("@/server/payments/types").PaymentProvider;
type Verified = import("@/server/payments/types").VerifiedPayment;
type Listed = import("@/server/payments/types").ListedTransaction;

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());
afterEach(() => setProviderFactoryForTests("cardcom", null));

const ctx = { expired: () => false, deadline: Date.now() + 60_000 };

/** A fixture Cardcom adapter: `paid` LowProfile ids answer succeeded, others pending. */
function fakeCardcom(o: { paid?: Set<string>; listed?: Listed[] } = {}) {
  const calls = { fetch: 0 };
  const provider: Provider = {
    id: "cardcom",
    mode: "TEST",
    capabilities: {
      currencies: ["ILS"],
      wallets: [],
      installments: true,
      notificationAuth: "unsigned-requery",
      requiresCapture: false,
      refunds: "manual",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },
    merchantRef: () => "1000",
    authenticateNotification: async () => false,
    parseNotification: () => ({ eventKey: "x", payloadRedacted: {} }),
    createCheckout: async () => {
      throw new Error("unused");
    },
    fetchPayment: async (r) => {
      calls.fetch += 1;
      const [a] = await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, r.attemptId));
      const paid = o.paid?.has(r.providerRef) ?? false;
      const vp: Verified = {
        state: paid ? "succeeded" : "pending",
        amount:
          paid && a
            ? { amountMinor: a.amountMinor, currency: a.currency }
            : null,
        echoedReference: r.attemptId,
        merchantRef: "1000",
        ...(paid
          ? { transactionId: `T-${r.providerRef}`, method: "card" }
          : {}),
        rawRedacted: {},
      };
      return vp;
    },
    refund: async () => ({ status: "manual_required", rawRedacted: {} }),
    listTransactions: async () => o.listed ?? [],
  };
  setProviderFactoryForTests("cardcom", () => provider);
  return { provider, calls };
}

/** A held web order whose attempt is turned into a Cardcom attempt (LowProfile `lp`). */
async function cardcomOrder(lp: string) {
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug);
  await execSql(
    `UPDATE payment_attempts SET provider = 'CARDCOM', provider_mode = 'TEST', merchant_ref = '1000',
       provider_ref = $2 WHERE id = $1`,
    [h.attemptId, lp],
  );
  return { ...h, art };
}

async function lapse(orderId: string, artworkId: string) {
  await execSql(
    `UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
    [artworkId],
  );
  await execSql(
    `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
    [orderId],
  );
}

async function orderOf(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("no order");
  return row;
}
async function attemptOf(id: string) {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, id));
  if (!row) throw new Error("no attempt");
  return row;
}

describe("reconcile expiry", () => {
  it("releases lapsed holds and expires link requests, but never a hold whose payment is in flight", async () => {
    // A lapsed WEB hold.
    const a = await buyableArtwork(db);
    const web = await heldOrder(a.slug);
    await lapse(web.orderId, a.id);
    // A lapsed link order with its quote request.
    const b = await buyableArtwork(db);
    const req = await insertBuyerRequest(db, { artworkId: b.id });
    const link = await linkOrder(b, { kind: "QUOTE", requestId: req.id });
    await lapse(link.orderId, b.id);
    // A lapsed hold whose capture is in flight.
    const c = await buyableArtwork(db);
    mockProviderHooks.nextFlow = "CAPTURE";
    const capturing = await heldOrder(c.slug);
    await clickMockPay(capturing.ref, "pay");
    mockProviderHooks.captureTimeout = { applied: false };
    await finalizeAttempt(capturing.attemptId, { trigger: "return" });
    expect((await attemptOf(capturing.attemptId)).status).toBe("CAPTURING");
    await lapse(capturing.orderId, c.id);
    await execSql(
      "UPDATE payment_attempts SET next_check_at = now() + interval '1 hour'",
    );

    const run = await runCronJob("reconcile");
    expect(run.ok).toBe(true);
    expect(run.stats.ordersExpired).toBe(2);

    expect(await orderOf(web.orderId)).toMatchObject({
      status: "EXPIRED",
      statusReason: "HOLD_EXPIRED",
    });
    expect(await orderOf(link.orderId)).toMatchObject({
      status: "EXPIRED",
      statusReason: "LINK_EXPIRED",
    });
    const [r] = await db
      .select()
      .from(buyerRequests)
      .where(eq(buyerRequests.id, req.id));
    expect(r?.status).toBe("EXPIRED");
    const free = await db.select().from(artworks).where(eq(artworks.id, a.id));
    expect(free[0]?.reservedByOrderId).toBeNull();

    expect((await orderOf(capturing.orderId)).status).toBe("AWAITING_PAYMENT");
    const held = await db.select().from(artworks).where(eq(artworks.id, c.id));
    expect(held[0]?.reservedByOrderId).toBe(capturing.orderId);
  });
});

describe("Cardcom watch window and tail", () => {
  it("a pending Cardcom attempt past 72 h expires with a 30-day tail", async () => {
    fakeCardcom();
    const h = await cardcomOrder("LP-WATCH");
    await execSql(
      "UPDATE payment_attempts SET created_at = now() - interval '73 hours' WHERE id = $1",
      [h.attemptId],
    );
    const { result } = await finalizeAttempt(h.attemptId, {
      trigger: "reconcile",
    });
    expect(result.outcome).toBe("expired");
    const a = await attemptOf(h.attemptId);
    expect(a.status).toBe("EXPIRED");
    const days =
      ((a.tailUntil?.getTime() ?? 0) - a.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 3);
  });

  it("the daily tail applies a late payment; it skips attempts out of their window or polled today", async () => {
    const lateOrder = await cardcomOrder("LP-LATE");
    const outOfWindow = await cardcomOrder("LP-OLD");
    const recent = await cardcomOrder("LP-RECENT");
    const { calls } = fakeCardcom({
      paid: new Set(["LP-LATE", "LP-OLD", "LP-RECENT"]),
    });
    for (const h of [lateOrder, outOfWindow, recent]) {
      await lapse(h.orderId, h.art.id);
    }
    await runCronJob("reconcile"); // the holds lapse: orders EXPIRED, works free
    await execSql(
      `UPDATE payment_attempts SET status = 'EXPIRED', next_check_at = NULL,
         tail_until = now() + interval '20 days', last_checked_at = NULL WHERE id = $1`,
      [lateOrder.attemptId],
    );
    await execSql(
      `UPDATE payment_attempts SET status = 'EXPIRED', next_check_at = NULL,
         tail_until = now() - interval '1 day' WHERE id = $1`,
      [outOfWindow.attemptId],
    );
    await execSql(
      `UPDATE payment_attempts SET status = 'EXPIRED', next_check_at = NULL,
         tail_until = now() + interval '20 days', last_checked_at = now() - interval '1 hour' WHERE id = $1`,
      [recent.attemptId],
    );
    expect((await orderOf(lateOrder.orderId)).status).toBe("EXPIRED");

    const before = calls.fetch;
    const stats = await pollCardcomTail(ctx);
    expect(stats).toMatchObject({
      due: 1,
      processed: 1,
      outcomes: { paid: 1 },
    });
    expect(calls.fetch - before).toBe(1);
    expect((await orderOf(lateOrder.orderId)).status).toBe("PAID");
    expect((await attemptOf(outOfWindow.attemptId)).status).toBe("EXPIRED");
    expect((await attemptOf(recent.attemptId)).status).toBe("EXPIRED");
    // Idempotent: a second pass the same day polls nothing.
    expect((await pollCardcomTail(ctx)).due).toBe(0);
  });
});

describe("live ListTransactions sweep", () => {
  it("finalizes a matched transaction that was never applied and alerts on an unmatched one", async () => {
    const h = await cardcomOrder("LP-SWEEP");
    const { provider } = fakeCardcom({
      paid: new Set(["LP-SWEEP"]),
      listed: [],
    });
    const [attempt] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    const listed: Listed[] = [
      {
        transactionId: "T-LP-SWEEP",
        amount: { amountMinor: attempt?.amountMinor ?? 0, currency: "ILS" },
        returnValue: h.attemptId,
        lowProfileId: "LP-SWEEP",
      },
      {
        transactionId: "T-STRANGER",
        amount: { amountMinor: 12_345, currency: "ILS" },
      },
    ];
    provider.listTransactions = async () => listed;

    const stats = await sweepCardcomTransactions(ctx, { provider });
    expect(stats).toMatchObject({
      listed: 2,
      matched: 1,
      finalized: 1,
      unmatched: 1,
      outcomes: { paid: 1 },
    });
    expect((await orderOf(h.orderId)).status).toBe("PAID");
    const alerts = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "UNMATCHED_CARDCOM_TRANSACTION"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("CRITICAL");

    // A second sweep: the payment is already applied, the alert is not duplicated.
    const again = await sweepCardcomTransactions(ctx, { provider });
    expect(again).toMatchObject({
      matched: 1,
      alreadyApplied: 1,
      finalized: 0,
    });
    expect(
      await db
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.kind, "UNMATCHED_CARDCOM_TRANSACTION")),
    ).toHaveLength(1);
  });

  it("is skipped unless Cardcom is live with an API password", async () => {
    const stats = await sweepCardcomTransactions(ctx);
    expect(stats.skipped).toBe("not_live");
  });
});
