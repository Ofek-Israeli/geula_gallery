import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";

/**
 * A TEST-mode payment never sells a real work (the checkout preview, docs/deploy.md "Checkout
 * preview and Isracard"): finalize closes the attempt (`TEST_PAYMENT`), releases the order's holds
 * and ends the order EXPIRED, with no sale, shipment, email, tax document, capture or refund,
 * whatever the provider reports. A TEST attempt whose terminal is gone is retired (`TEST_RETIRED`)
 * without a CONFIG_DRIFT alert. Demo works keep the full paid flow.
 */
const { db } = await import("@/server/db/client");
const { adminAlerts, artworks, orders, outboxJobs, paymentAttempts, sales } =
  await import("@/server/db/schema");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { handlePaymentReturn, buyerOutcome } = await import(
  "@/server/payments/webhook"
);
const { setProviderFactoryForTests } = await import(
  "@/server/payments/registry"
);
const { checkInvariants } = await import("@/server/invariants");
const { hmacToken } = await import("@/server/security/tokens");
type Provider = import("@/server/payments/types").PaymentProvider;
type Verified = import("@/server/payments/types").VerifiedPayment;

cleanDatabaseBeforeEach();
afterEach(() => setProviderFactoryForTests("cardcom", null));

/** A fixture TEST terminal: `states` maps provider refs to what the terminal reports. */
function fakeTerminal(
  o: {
    mode?: "TEST" | "LIVE";
    merchantRef?: string;
    states?: Map<string, Verified["state"]>;
  } = {},
) {
  const calls = { fetch: 0, capture: 0 };
  const provider: Provider = {
    id: "cardcom",
    mode: o.mode ?? "TEST",
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
    merchantRef: () => o.merchantRef ?? "1000",
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
      const state = o.states?.get(r.providerRef) ?? "pending";
      return {
        state,
        amount:
          state === "pending" || !a
            ? null
            : { amountMinor: a.amountMinor, currency: a.currency },
        echoedReference: r.attemptId,
        merchantRef: o.merchantRef ?? "1000",
        transactionId: "tx-1",
        last4: "0008",
        brand: "VISA",
        rawRedacted: {},
      };
    },
    capture: async () => {
      calls.capture += 1;
      throw new Error("a TEST payment must never be captured");
    },
    refund: async () => ({ status: "manual_required", rawRedacted: {} }),
  };
  setProviderFactoryForTests("cardcom", () => provider);
  return { provider, calls };
}

/** A held order whose attempt is turned into a test-terminal attempt (`lp`). */
async function testTerminalOrder(lp: string, opts: { demo?: boolean } = {}) {
  const art = await buyableArtwork(db, { isDemo: opts.demo ?? false });
  const h = await heldOrder(art.slug);
  await execSql(
    `UPDATE payment_attempts SET provider = 'CARDCOM', provider_mode = 'TEST', merchant_ref = '1000',
       provider_ref = $2 WHERE id = $1`,
    [h.attemptId, lp],
  );
  return { ...h, art };
}

async function attemptRow(id: string) {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, id));
  return row;
}
async function orderRow(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}
async function artworkRow(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  return row;
}

describe("a TEST payment on a real work", () => {
  it("is closed: nothing sold, no email or document, the hold released and the order EXPIRED", async () => {
    fakeTerminal({ states: new Map([["lp-1", "succeeded"]]) });
    const h = await testTerminalOrder("lp-1");
    const jobsBefore = (await db.select().from(outboxJobs)).length;

    const { result } = await finalizeAttempt(h.attemptId, {
      trigger: "webhook",
    });
    expect(result).toMatchObject({
      outcome: "test_payment",
      attemptStatus: "CANCELED",
      orderStatus: "EXPIRED",
    });
    expect(await attemptRow(h.attemptId)).toMatchObject({
      failureReason: "TEST_PAYMENT",
      cardLast4: "0008",
      nextCheckAt: null,
    });
    expect(await orderRow(h.orderId)).toMatchObject({
      status: "EXPIRED",
      statusReason: "TEST_PAYMENT",
    });
    expect(await artworkRow(h.art.id)).toMatchObject({
      saleStatus: "AVAILABLE",
      reservedByOrderId: null,
      reservedUntil: null,
    });
    expect(await db.select().from(sales)).toEqual([]);
    expect((await db.select().from(outboxJobs)).length).toBe(jobsBefore);
    const report = await checkInvariants({ graceMinutes: 0 });
    expect(report.violations).toEqual([]);

    // The return after the webhook reports the test, not a failure.
    const back = await handlePaymentReturn({
      provider: "cardcom",
      query: new URLSearchParams({
        a: h.attemptId,
        r: hmacToken("return", h.attemptId),
        l: "en",
        s: "success",
      }),
      ip: "203.0.113.5",
    });
    expect(back.status).toBe(303);
    expect(back.location).toContain("payment=test_payment");
  });

  it("is closed without a capture call or review hold, whatever the terminal reports", async () => {
    const t = fakeTerminal({
      states: new Map([
        ["lp-cap", "requires_capture"],
        ["lp-rev", "review"],
      ]),
    });
    const cap = await testTerminalOrder("lp-cap");
    const rev = await testTerminalOrder("lp-rev");
    for (const h of [cap, rev]) {
      const { result } = await finalizeAttempt(h.attemptId, {
        trigger: "reconcile",
      });
      expect(result.outcome).toBe("test_payment");
      expect(await artworkRow(h.art.id)).toMatchObject({
        saleStatus: "AVAILABLE",
        reservedByOrderId: null,
      });
    }
    expect(t.calls.capture).toBe(0);
    expect(await db.select().from(sales)).toEqual([]);
  });

  it("leaves another buyer's hold alone when it arrives after a takeover", async () => {
    fakeTerminal({ states: new Map([["lp-late", "succeeded"]]) });
    const first = await testTerminalOrder("lp-late");
    // The first hold lapses and a second buyer takes the work.
    await execSql(
      `UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
      [first.art.id],
    );
    await execSql(
      `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [first.orderId],
    );
    const second = await heldOrder(first.art.slug);

    const { result } = await finalizeAttempt(first.attemptId, {
      trigger: "webhook",
    });
    expect(result.outcome).toBe("test_payment");
    expect(await artworkRow(first.art.id)).toMatchObject({
      saleStatus: "AVAILABLE",
      reservedByOrderId: second.orderId,
    });
    expect((await orderRow(second.orderId))?.status).toBe("AWAITING_PAYMENT");
  });

  it("is retired without a CONFIG_DRIFT alert once the terminal is no longer a test one", async () => {
    fakeTerminal({ states: new Map([["lp-old", "pending"]]) });
    const h = await testTerminalOrder("lp-old");
    // Go-live: the same adapter now runs on the live terminal.
    const live = fakeTerminal({ mode: "LIVE", merchantRef: "777" });

    const { result } = await finalizeAttempt(h.attemptId, {
      trigger: "reconcile",
    });
    expect(result.outcome).toBe("test_payment");
    expect(live.calls.fetch).toBe(0);
    expect(await attemptRow(h.attemptId)).toMatchObject({
      status: "CANCELED",
      failureReason: "TEST_RETIRED",
    });
    expect((await orderRow(h.orderId))?.statusReason).toBe("TEST_PAYMENT");
    const alerts = await db.select().from(adminAlerts);
    expect(alerts.filter((a) => a.kind === "CONFIG_DRIFT")).toEqual([]);
  });
});

describe("TEST payments elsewhere", () => {
  it("a demo work keeps the full paid flow", async () => {
    fakeTerminal({ states: new Map([["lp-demo", "succeeded"]]) });
    const h = await testTerminalOrder("lp-demo", { demo: true });
    const { result } = await finalizeAttempt(h.attemptId, {
      trigger: "webhook",
    });
    expect(result).toMatchObject({ outcome: "paid", orderStatus: "PAID" });
    expect(await db.select().from(sales)).toHaveLength(1);
  });

  it("the buyer's outcome names a closed test payment", () => {
    expect(buyerOutcome("already_final", "CANCELED", "TEST_PAYMENT")).toBe(
      "test_payment",
    );
    expect(buyerOutcome("already_final", "FAILED", "TEST_PAYMENT:amount")).toBe(
      "test_payment",
    );
    expect(buyerOutcome("already_final", "CANCELED", "TEST_RETIRED")).toBe(
      "test_payment",
    );
    expect(buyerOutcome("already_final", "CANCELED", null)).toBe("canceled");
  });
});
