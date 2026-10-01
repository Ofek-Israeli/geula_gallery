import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { mockWebhookBody, signMockWebhook } from "../helpers/mock-webhook";

/**
 * Webhook replay and post-success events (spec §5.2 "Webhook route", §5.3 #4–7, #17, #19; §10.3
 * `webhook-replay`): a processing failure answers 500 and the redelivery (or reconcile) processes
 * the event; refund / reversal / dispute events go to `syncPostSuccessEvent` (our own refund is
 * matched, never double-counted; reversals and disputes block fulfillment); forged requests never
 * write a payment event.
 */
const { db } = await import("@/server/db/client");
const {
  adminAlerts,
  orders,
  outboxJobs,
  paymentAttempts,
  paymentEvents,
  refunds,
} = await import("@/server/db/schema");
const { handlePaymentWebhook } = await import("@/server/payments/webhook");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { syncPostSuccessEvent } = await import("@/server/payments/post-success");
const { requestRefund } = await import("@/server/payments/refunds");
const { setProviderFactoryForTests } = await import(
  "@/server/payments/registry"
);
const { runCronJob } = await import("@/server/jobs");
const { parsePaypalEvent } = await import(
  "@/server/payments/providers/paypal-map"
);
const { mockProviderHooks, resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
type Provider = import("@/server/payments/types").PaymentProvider;

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());
afterEach(() => setProviderFactoryForTests("paypal", null));

const SECRET = process.env.MOCK_WEBHOOK_SECRET ?? "";
const IP = "203.0.113.9";

function mockSend(ref: string, opts: { forged?: boolean; id?: string } = {}) {
  const raw = mockWebhookBody(ref, opts.id ? { id: opts.id } : {});
  return handlePaymentWebhook({
    provider: "mock",
    headers: new Headers({
      "x-mock-signature": signMockWebhook(
        raw,
        opts.forged ? "test-wrong-secret-0123456789" : SECRET,
      ),
    }),
    rawBody: raw,
    query: new URLSearchParams(),
    ip: IP,
  });
}

/**
 * A fixture PayPal adapter for the webhook path only: authenticates a test header (the verify
 * postback needs PayPal) and parses events with the real adapter's `parsePaypalEvent`.
 */
function fakePaypal(): Provider {
  const fail = (): never => {
    throw new Error("not used by these tests");
  };
  return {
    id: "paypal",
    mode: "TEST",
    capabilities: {
      currencies: ["ILS", "USD"],
      wallets: [],
      installments: false,
      notificationAuth: "signature",
      requiresCapture: true,
      refunds: "api",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },
    merchantRef: () => "TESTMERCHANT",
    authenticateNotification: async (n) =>
      n.headers.get("x-test-paypal") === "verified",
    // The real WS5 parser: post-success routing depends on its redacted payload.
    parseNotification: (n) => parsePaypalEvent(n.rawBody),
    createCheckout: fail,
    fetchPayment: fail,
    refund: fail,
  };
}

function paypalSend(body: Record<string, unknown>) {
  return handlePaymentWebhook({
    provider: "paypal",
    headers: new Headers({ "x-test-paypal": "verified" }),
    rawBody: JSON.stringify(body),
    query: new URLSearchParams(),
    ip: IP,
  });
}

/** A paid order whose attempt is turned into a captured PayPal payment (capture CAP-<n>). */
async function paidPaypalOrder(captureId: string) {
  setProviderFactoryForTests("paypal", fakePaypal);
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug);
  await clickMockPay(h.ref, "pay");
  await finalizeAttempt(h.attemptId, { trigger: "return" });
  await execSql(
    `UPDATE payment_attempts SET provider = 'PAYPAL', provider_mode = 'TEST', merchant_ref = 'TESTMERCHANT',
       provider_ref = $2, capture_id = $3 WHERE id = $1`,
    [h.attemptId, `PP-${captureId}`, captureId],
  );
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, h.attemptId));
  if (!attempt) throw new Error("no attempt");
  return { ...h, attempt };
}

function refundEvent(
  id: string,
  o: {
    refundId: string;
    captureId: string;
    value: string;
    customId?: string;
    status?: string;
  },
) {
  return {
    id,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource_type: "refund",
    resource: {
      id: o.refundId,
      status: o.status ?? "COMPLETED",
      amount: { value: o.value, currency_code: "ILS" },
      ...(o.customId ? { custom_id: o.customId } : {}),
      links: [
        {
          rel: "up",
          href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${o.captureId}`,
        },
      ],
    },
  };
}

async function orderOf(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("no order");
  return row;
}

describe("webhook replay", () => {
  it("processing fails once → 500 and unprocessed; the redelivery is processed once", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    mockProviderHooks.fetchTimeout = true;
    const first = await mockSend(h.ref, { id: "evt_replay_1" });
    expect(first.status).toBe(500);
    const [stored] = await db.select().from(paymentEvents);
    expect(stored?.processedAt).toBeNull();

    const second = await mockSend(h.ref, { id: "evt_replay_1" });
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("paid");
    const third = await mockSend(h.ref, { id: "evt_replay_1" });
    expect(third.body).toMatchObject({ duplicate: true });
    const [event] = await db.select().from(paymentEvents);
    expect(event?.receivedCount).toBe(3);
    expect((await orderOf(h.orderId)).status).toBe("PAID");
  });

  it("forged requests never write a payment event; repeated failures are rate limited", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await mockSend(h.ref, { forged: true })).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(await db.select().from(paymentEvents)).toHaveLength(0);
    expect((await orderOf(h.orderId)).status).toBe("AWAITING_PAYMENT");
    // An authenticated webhook from the same IP is never limited.
    expect((await mockSend(h.ref)).status).toBe(200);
  });
});

describe("post-success events (PayPal)", () => {
  it("our own refund's webhook is matched by custom_id: SUCCEEDED + REFUND_SETTLED, not EXTERNAL", async () => {
    const p = await paidPaypalOrder("CAP-OWN");
    const { result } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: p.attempt.amountMinor,
      reason: "ADMIN",
      requestedBy: "admin:test",
    });
    // Our refund call is in flight when PayPal's webhook arrives.
    await execSql(
      `UPDATE refunds SET status = 'IN_FLIGHT', in_flight_until = now() + interval '2 minutes' WHERE id = $1`,
      [result.refundId],
    );
    const value = (p.attempt.amountMinor / 100).toFixed(2);
    const res = await paypalSend(
      refundEvent("WH-OWN-1", {
        refundId: "PPRF-1",
        captureId: "CAP-OWN",
        value,
        customId: result.refundId,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("matched");
    const rows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, p.attemptId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "SUCCEEDED",
      providerRefundId: "PPRF-1",
    });
    const jobs = await db
      .select({ key: outboxJobs.dedupeKey })
      .from(outboxJobs);
    expect(jobs.map((j) => j.key)).toContain(
      `refund-settled:${result.refundId}`,
    );
  });

  it("an unknown refund found by the capture id is recorded EXTERNAL and blocks fulfillment", async () => {
    const p = await paidPaypalOrder("CAP-EXT");
    const res = await paypalSend(
      refundEvent("WH-EXT-1", {
        refundId: "PPRF-EXT",
        captureId: "CAP-EXT",
        value: "100.00",
      }),
    );
    expect(res.body.outcome).toBe("external");
    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, p.attemptId));
    expect(row).toMatchObject({
      reason: "EXTERNAL",
      status: "SUCCEEDED",
      amountMinor: 10_000,
      providerRefundId: "PPRF-EXT",
    });
    expect((await orderOf(p.orderId)).fulfillmentBlockedReason).toBe(
      "EXTERNAL_REFUND",
    );
    // The same event again is a duplicate: no second row.
    expect(
      (
        await paypalSend(
          refundEvent("WH-EXT-1", {
            refundId: "PPRF-EXT",
            captureId: "CAP-EXT",
            value: "100.00",
          }),
        )
      ).body,
    ).toMatchObject({ duplicate: true });
    expect(
      await db.select().from(refunds).where(eq(refunds.attemptId, p.attemptId)),
    ).toHaveLength(1);
  });

  it("a REVERSED whose processing fails answers 500; the retry blocks fulfillment with a CRITICAL alert", async () => {
    const p = await paidPaypalOrder("CAP-REV");
    let calls = 0;
    const flaky: typeof syncPostSuccessEvent = async (event, deps) => {
      calls += 1;
      if (calls === 1) throw new Error("database hiccup");
      return syncPostSuccessEvent(event, deps);
    };
    const body = {
      id: "WH-REV-1",
      event_type: "PAYMENT.CAPTURE.REVERSED",
      resource_type: "refund",
      resource: {
        id: "PPRF-REV",
        status: "COMPLETED",
        amount: { value: "10.00", currency_code: "ILS" },
        links: [
          {
            rel: "up",
            href: "https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-REV",
          },
        ],
      },
    };
    const send = () =>
      handlePaymentWebhook(
        {
          provider: "paypal",
          headers: new Headers({ "x-test-paypal": "verified" }),
          rawBody: JSON.stringify(body),
          query: new URLSearchParams(),
          ip: IP,
        },
        { syncPostSuccess: flaky },
      );
    expect((await send()).status).toBe(500);
    const [pending] = await db.select().from(paymentEvents);
    expect(pending?.processedAt).toBeNull();
    expect(pending?.lastError).toContain("database hiccup");
    expect((await orderOf(p.orderId)).fulfillmentBlockedReason).toBeNull();

    const retry = await send();
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe("flagged");
    expect((await orderOf(p.orderId)).fulfillmentBlockedReason).toBe(
      "PAYMENT_REVERSED",
    );
    const alerts = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "PAYMENT_REVERSED"));
    expect(alerts[0]?.severity).toBe("CRITICAL");
  });

  it("reconcile replays an unprocessed dispute event (found by the disputed capture)", async () => {
    const p = await paidPaypalOrder("CAP-DSP");
    const failing: typeof syncPostSuccessEvent = async () => {
      throw new Error("timeout");
    };
    const res = await handlePaymentWebhook(
      {
        provider: "paypal",
        headers: new Headers({ "x-test-paypal": "verified" }),
        rawBody: JSON.stringify({
          id: "WH-DSP-1",
          event_type: "CUSTOMER.DISPUTE.CREATED",
          resource_type: "dispute",
          resource: {
            id: "PP-D-1",
            status: "OPEN",
            disputed_transactions: [{ seller_transaction_id: "CAP-DSP" }],
          },
        }),
        query: new URLSearchParams(),
        ip: IP,
      },
      { syncPostSuccess: failing },
    );
    expect(res.status).toBe(500);
    await execSql(
      "UPDATE payment_events SET received_at = now() - interval '3 minutes'",
    );
    const run = await runCronJob("reconcile");
    expect(run.ok).toBe(true);
    const [event] = await db.select().from(paymentEvents);
    expect(event?.processedAt).toBeInstanceOf(Date);
    expect(event?.outcome).toBe("dispute:flagged");
    expect(event?.attemptId).toBe(p.attemptId);
    expect((await orderOf(p.orderId)).fulfillmentBlockedReason).toBe("DISPUTE");
  });

  it("an event for no known payment is acknowledged once with a CRITICAL alert", async () => {
    setProviderFactoryForTests("paypal", fakePaypal);
    const res = await paypalSend(
      refundEvent("WH-NONE", {
        refundId: "PPRF-NONE",
        captureId: "CAP-UNKNOWN",
        value: "5.00",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("unmatched");
    expect(await db.select().from(refunds)).toHaveLength(0);
    const [alert] = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "PAYMENT_EVENT_UNMATCHED"));
    expect(alert?.severity).toBe("CRITICAL");
  });
});
