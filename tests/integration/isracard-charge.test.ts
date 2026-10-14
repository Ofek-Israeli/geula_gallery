import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach, testEnv } from "../helpers/db";
import {
  buyableArtwork,
  checkoutInput,
  execSql,
} from "../helpers/factories/commerce";

/**
 * The Isracard pay page charge (`src/server/payments/charge.ts`) with a fake hosted-fields
 * adapter: one claim, one `generate-sale`, one `pay-sale` per attempt; completed → finalized;
 * 3-D Secure → the challenge URL; declined → FAILED and a new attempt's pay page; unknown → left
 * CAPTURING (hold kept) and settled by finalize; finalize never charges; an unsubmitted pay page
 * and a stuck charge end their holds.
 */
const { db } = await import("@/server/db/client");
const { adminAlerts, artworks, orders, paymentAttempts, sales } = await import(
  "@/server/db/schema"
);
const { parseEnv } = await import("@/server/env");
const { startCheckout } = await import("@/server/checkout/start");
const { expireStaleOrders } = await import("@/server/checkout/release");
const { chargeAttemptWithToken } = await import("@/server/payments/charge");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { handlePaymentReturn } = await import("@/server/payments/webhook");
const { setProviderFactoryForTests } = await import(
  "@/server/payments/registry"
);
const { pendingSaleRef } = await import(
  "@/server/payments/providers/isracard-map"
);
const { hmacToken } = await import("@/server/security/tokens");
const { ProviderTimeoutError } = await import("@/server/integrations/http");
type HF = import("@/server/payments/types").HostedFieldsProvider;
type PaySaleResult = import("@/server/payments/types").PaySaleResult;
type Verified = import("@/server/payments/types").VerifiedPayment;

cleanDatabaseBeforeEach();
afterEach(() => setProviderFactoryForTests("isracard", null));

const env = parseEnv({
  ...testEnv(),
  PAYMENT_PROVIDERS: "isracard",
  ISRACARD_MODE: "test",
  ISRACARD_SELLER_ID: "MPL-TEST-SELLER",
  ISRACARD_JSAPI_KEY: "test-jsapi-key",
});

/** A fake PayMe: `pay` decides each `pay-sale`; `paid` holds the sales PayMe reports completed. */
function fakePayme(
  o: {
    pay?: () => PaySaleResult | Promise<PaySaleResult>;
    createFails?: boolean;
  } = {},
) {
  const calls = { create: 0, pay: 0, fetch: 0 };
  const paid = new Map<string, string>(); // attempt id → sale id
  let next = 0;
  const provider: HF = {
    id: "isracard",
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
    merchantRef: () => "mpl:fake",
    authenticateNotification: async () => false,
    parseNotification: () => ({ eventKey: "x", payloadRedacted: {} }),
    createCheckout: async (i) => ({
      providerRef: pendingSaleRef(i.attemptId),
      next: {
        kind: "redirect",
        url: `http://localhost:3000/${i.locale}/checkout/pay/${i.attemptId}?t=${hmacToken("isracard-pay", i.attemptId)}`,
      },
    }),
    fetchPayment: async (r) => {
      calls.fetch += 1;
      const [a] = await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, r.attemptId));
      const saleId = paid.get(r.attemptId);
      const vp: Verified = saleId
        ? {
            state: "succeeded",
            providerRef: saleId,
            amount: a
              ? { amountMinor: a.amountMinor, currency: a.currency }
              : null,
            echoedReference: r.attemptId,
            merchantRef: "mpl:fake",
            transactionId: `TRAN-${saleId}`,
            last4: "5846",
            rawRedacted: {},
          }
        : {
            state: "pending",
            amount: null,
            echoedReference: null,
            merchantRef: null,
            rawRedacted: {},
          };
      return vp;
    },
    refund: async () => ({ status: "manual_required", rawRedacted: {} }),
    hostedFields: {
      client: () => ({
        apiKey: "test-jsapi-key",
        testMode: true,
        scriptUrl: "https://cdn.payme.io/hf/v1/hostedfields.js",
      }),
      createSale: async (i) => {
        calls.create += 1;
        if (o.createFails) throw new Error("generate-sale refused");
        next += 1;
        return { saleId: `SALE-${next}-${i.attemptId.slice(0, 8)}` };
      },
      paySale: async (i) => {
        calls.pay += 1;
        const result = o.pay ? await o.pay() : { kind: "completed" as const };
        if (result.kind === "completed") paid.set(i.attemptId, i.saleId);
        return result;
      },
    },
  };
  setProviderFactoryForTests("isracard", () => provider);
  return { provider, calls, paid };
}

/** A held order paid through the Isracard pay page: the attempt is PENDING with `hf:`. */
async function payPageAttempt(opts: { demo?: boolean } = {}) {
  const art = await buyableArtwork(db, { isDemo: opts.demo ?? true });
  const input = await checkoutInput(art.slug, { env, providerId: "isracard" });
  const { result } = await startCheckout(input, { env });
  if (result.kind !== "redirect")
    throw new Error(`no redirect: ${result.kind}`);
  expect(result.fullPageLoad).toBe(true);
  expect(result.url).toContain("/checkout/pay/");
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, result.orderId));
  if (!attempt) throw new Error("no attempt");
  expect(attempt).toMatchObject({
    status: "PENDING",
    providerRef: pendingSaleRef(attempt.id),
    provider: "ISRACARD",
  });
  return { art, orderId: result.orderId, attemptId: attempt.id };
}

function charge(attemptId: string, over: { ipHash?: string } = {}) {
  return chargeAttemptWithToken(
    {
      attemptId,
      buyerKey: "BUYER-TOKEN",
      clientData: "client-jwt",
      socialId: "000000018",
      installments: 1,
      locale: "en",
      ipHash: over.ipHash ?? "ip-test",
    },
    { env },
  );
}

async function attemptRow(id: string) {
  const [row] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, id));
  return row;
}

describe("the Isracard pay page charge", () => {
  it("completed: one sale, one charge, verified and paid", async () => {
    const pm = fakePayme();
    const h = await payPageAttempt();
    const { result } = await charge(h.attemptId);
    expect(result).toMatchObject({ kind: "navigate" });
    expect(result.kind === "navigate" && result.url).toContain("payment=paid");
    expect(pm.calls).toMatchObject({ create: 1, pay: 1 });
    expect(await attemptRow(h.attemptId)).toMatchObject({
      status: "SUCCEEDED",
      providerRef: expect.stringMatching(/^SALE-1-/),
      cardLast4: "5846",
    });
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    expect(order?.status).toBe("PAID");
    expect(await db.select().from(sales)).toHaveLength(1);
  });

  it("concurrent submits charge exactly once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pm = fakePayme({
      pay: async () => {
        await gate;
        return { kind: "completed" };
      },
    });
    const h = await payPageAttempt();
    const first = charge(h.attemptId);
    const second = charge(h.attemptId);
    // The second loses the claim and goes to the order page at once.
    const lost = await second;
    expect(lost.result.kind === "navigate" && lost.result.url).toContain(
      "/orders/",
    );
    release();
    await first;
    expect(pm.calls.pay).toBe(1);
    expect(pm.calls.create).toBe(1);
  });

  it("3-D Secure: the buyer goes to the challenge; the return route finalizes", async () => {
    const pm = fakePayme({
      pay: () => ({
        kind: "challenge",
        redirectUrl: "https://acs.example.test/challenge",
      }),
    });
    const h = await payPageAttempt();
    const { result } = await charge(h.attemptId);
    expect(result).toEqual({
      kind: "navigate",
      url: "https://acs.example.test/challenge",
    });
    expect(await attemptRow(h.attemptId)).toMatchObject({
      status: "CAPTURING",
      redirectUrl: "https://acs.example.test/challenge",
    });
    // The challenge succeeded at PayMe; the buyer comes back through the return route.
    const row = await attemptRow(h.attemptId);
    pm.paid.set(h.attemptId, row?.providerRef ?? "");
    const back = await handlePaymentReturn(
      {
        provider: "isracard",
        query: new URLSearchParams({
          a: h.attemptId,
          r: hmacToken("return", h.attemptId),
          l: "en",
          s: "success",
        }),
        ip: "203.0.113.5",
      },
      { env },
    );
    expect(back.location).toContain("payment=paid");
    expect(pm.calls.pay).toBe(1);
  });

  it("declined: the attempt fails and a new attempt's pay page opens", async () => {
    const pm = fakePayme({
      pay: () => ({ kind: "declined", code: "301", message: "declined" }),
    });
    const h = await payPageAttempt();
    const { result } = await charge(h.attemptId);
    expect(result.kind === "navigate" && result.url).toMatch(
      /\/checkout\/pay\/[0-9a-f-]{36}\?t=.+&declined=1$/,
    );
    expect(await attemptRow(h.attemptId)).toMatchObject({
      status: "FAILED",
      failureReason: "DECLINED:301",
    });
    const all = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, h.orderId));
    expect(all).toHaveLength(2);
    expect(pm.calls.pay).toBe(1);
  });

  it("a lost answer stays CAPTURING with the hold kept; finalize settles it without charging", async () => {
    const pm = fakePayme({
      pay: () => {
        throw new ProviderTimeoutError("isracard");
      },
    });
    const h = await payPageAttempt();
    const { result } = await charge(h.attemptId);
    expect(result.kind === "navigate" && result.url).toContain(
      "payment=capturing",
    );
    expect((await attemptRow(h.attemptId))?.status).toBe("CAPTURING");
    // The hold lapses on the clock, but the expiry job keeps an order whose payment is in flight.
    await execSql(
      `UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [h.orderId],
    );
    await expireStaleOrders({ limit: 10, deadline: Date.now() + 10_000 });
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    expect(order?.status).toBe("AWAITING_PAYMENT");
    // PayMe did charge: reconcile (and the admin's recheck) verify it, never charging again.
    pm.paid.set(
      h.attemptId,
      (await attemptRow(h.attemptId))?.providerRef ?? "",
    );
    const { result: checked } = await finalizeAttempt(h.attemptId, {
      trigger: "admin",
      env,
    });
    expect(checked.outcome).toBe("paid");
    expect(pm.calls.pay).toBe(1);
  });

  it("a lapsed hold is refused before any provider call", async () => {
    const pm = fakePayme();
    const h = await payPageAttempt();
    await execSql(
      `UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
      [h.art.id],
    );
    const { result } = await charge(h.attemptId);
    expect(result.kind === "navigate" && result.url).toContain(
      "err=not_payable",
    );
    expect(pm.calls).toMatchObject({ create: 0, pay: 0 });
    expect((await attemptRow(h.attemptId))?.status).toBe("PENDING");
  });

  it("a sale refused at creation fails the attempt without charging", async () => {
    const pm = fakePayme({ createFails: true });
    const h = await payPageAttempt();
    await charge(h.attemptId);
    expect(await attemptRow(h.attemptId)).toMatchObject({ status: "FAILED" });
    expect((await attemptRow(h.attemptId))?.failureReason).toMatch(/^CREATE:/);
    expect(pm.calls.pay).toBe(0);
  });

  it("an unsubmitted pay page: no provider call, closed once its hold lapsed", async () => {
    const pm = fakePayme();
    const h = await payPageAttempt();
    const { result: open } = await finalizeAttempt(h.attemptId, {
      trigger: "reconcile",
      env,
    });
    expect(open.outcome).toBe("pending");
    await execSql(
      `UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1`,
      [h.art.id],
    );
    const { result: closed } = await finalizeAttempt(h.attemptId, {
      trigger: "reconcile",
      env,
    });
    expect(closed.outcome).toBe("canceled");
    expect(await attemptRow(h.attemptId)).toMatchObject({
      status: "CANCELED",
      failureReason: "NOT_SUBMITTED",
    });
    expect(pm.calls.fetch).toBe(0);
  });

  it("a charge stuck past the watch is closed, its hold ended, with a warning", async () => {
    fakePayme({
      pay: () => {
        throw new ProviderTimeoutError("isracard");
      },
    });
    const h = await payPageAttempt();
    await charge(h.attemptId);
    await execSql(
      `UPDATE payment_attempts SET capturing_since = now() - interval '2 hours' WHERE id = $1`,
      [h.attemptId],
    );
    const { result } = await finalizeAttempt(h.attemptId, {
      trigger: "reconcile",
      env,
    });
    expect(result.outcome).toBe("canceled");
    expect(await attemptRow(h.attemptId)).toMatchObject({
      status: "CANCELED",
      failureReason: "CHARGE_NOT_COMPLETED",
    });
    const [work] = await db
      .select()
      .from(artworks)
      .where(eq(artworks.id, h.art.id));
    expect(work?.reservedUntil?.getTime()).toBeLessThanOrEqual(Date.now());
    const alerts = await db.select().from(adminAlerts);
    expect(alerts.map((a) => a.kind)).toContain("CHARGE_NOT_COMPLETED");
  });

  it("a sale whose id was never stored is adopted by finalize and paid", async () => {
    const pm = fakePayme();
    const h = await payPageAttempt();
    // The sale exists at PayMe, but the process stopped before storing its id.
    await execSql(
      `UPDATE payment_attempts SET status = 'CAPTURING', capturing_since = now() WHERE id = $1`,
      [h.attemptId],
    );
    pm.paid.set(h.attemptId, "SALE-ADOPTED");
    const { result } = await finalizeAttempt(h.attemptId, {
      trigger: "webhook",
      env,
    });
    expect(result.outcome).toBe("paid");
    expect(await attemptRow(h.attemptId)).toMatchObject({
      providerRef: "SALE-ADOPTED",
      status: "SUCCEEDED",
    });
    expect(pm.calls.pay).toBe(0);
  });

  it("a TEST charge on a real work is a test payment: nothing sold", async () => {
    fakePayme();
    const h = await payPageAttempt({ demo: false });
    const { result } = await charge(h.attemptId);
    expect(result.kind === "navigate" && result.url).toContain(
      "payment=test_payment",
    );
    const [work] = await db
      .select()
      .from(artworks)
      .where(eq(artworks.id, h.art.id));
    expect(work).toMatchObject({
      saleStatus: "AVAILABLE",
      reservedByOrderId: null,
    });
    expect(await db.select().from(sales)).toEqual([]);
  });
});

describe("the Isracard daily sweep", () => {
  const ctx = { expired: () => false, deadline: Date.now() + 60_000 };

  it("raises CRITICAL alerts for unmatched money and for money on a closed attempt", async () => {
    const { sweepIsracardTransactions } = await import(
      "@/server/payments/sweep"
    );
    const pm = fakePayme({
      pay: () => ({ kind: "declined", code: "301", message: "declined" }),
    });
    const h = await payPageAttempt();
    await charge(h.attemptId); // FAILED (declined) and a new attempt
    const failed = await attemptRow(h.attemptId);
    pm.provider.listTransactions = async () => [
      {
        transactionId: "TRAN-ON-CLOSED",
        amount: { amountMinor: 150_000, currency: "ILS" },
        returnValue: h.attemptId,
        lowProfileId: failed?.providerRef ?? undefined,
      },
      {
        transactionId: "TRAN-UNKNOWN",
        amount: { amountMinor: 99_000, currency: "ILS" },
      },
    ];
    const stats = await sweepIsracardTransactions(ctx, {
      provider: pm.provider,
      env,
    });
    expect(stats).toMatchObject({
      listed: 2,
      unmatched: 1,
      onClosedAttempt: 1,
    });
    const kinds = (await db.select().from(adminAlerts)).map((a) => a.kind);
    expect(kinds).toContain("UNMATCHED_ISRACARD_TRANSACTION");
    expect(kinds).toContain("PAYMENT_ON_CLOSED_ATTEMPT");
  });
});
