import { describe, expect, it } from "vitest";
import {
  ATTEMPT_ID,
  checkoutInput,
  paymentProviderContract,
} from "./payment-provider.suite";
import { ISRACARD_ENV, makeEnv } from "./support/env";
import {
  loadFixture,
  type ReplayRoute,
  replayFetch,
  routesFrom,
  timeoutError,
} from "./support/replay";

/**
 * Isracard (PayMe) adapter on fixtures (`providers/isracard.ts`): the shared provider contract,
 * then the pay page's charge (generate-sale, pay-sale), get-transactions lookups, refunds and the
 * sweep listing. The fixtures in `tests/fixtures/isracard` are synthetic, written from
 * docs.payme.io (read 2026-10-14), until `npm run check:isracard -- --record` records the sandbox.
 */
const { createIsracardProvider } = await import(
  "@/server/payments/providers/isracard"
);
const { sellerFingerprint } = await import(
  "@/server/payments/providers/isracard-map"
);
const { hmacToken, verifyHmacToken } = await import("@/server/security/tokens");
const {
  ProviderInvalidResponseError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} = await import("@/server/integrations/http");
type CreateSaleInput = import("@/server/payments/types").CreateSaleInput;
type PaySaleInput = import("@/server/payments/types").PaySaleInput;

const SELLER = ISRACARD_ENV.ISRACARD_SELLER_ID;
const SALE = "SALE1655-0000AAAA-BBBBCCCC-DDDDEEEE";
const env = await makeEnv(ISRACARD_ENV);
const withClientKey = await makeEnv({
  ...ISRACARD_ENV,
  ISRACARD_CLIENT_KEY: "placeholder-client-key",
});
/** `none`: calls that make no request (createCheckout). */
const routes = (scenario: string) =>
  scenario === "none" ? [] : routesFrom(loadFixture("isracard", scenario));

function build(r: ReplayRoute[], e = env) {
  const replay = replayFetch(r);
  return {
    provider: createIsracardProvider({ env: e, fetch: replay.fetch }),
    sent: replay.sent,
    pending: replay.pending,
  };
}

const callback = (t: string) => ({
  headers: new Headers({
    "content-type": "application/x-www-form-urlencoded",
  }),
  rawBody: new URLSearchParams({
    notify_type: "sale-complete",
    payme_sale_id: SALE,
    transaction_id: ATTEMPT_ID,
    sale_status: "completed",
    price: "125050",
    currency: "ILS",
    seller_payme_id: SELLER,
    buyer_name: "Test Buyer",
    buyer_email: "buyer@example.com",
    buyer_phone: "03-000-0000",
    buyer_social_id: "000000018",
    buyer_card_mask: "532610******5846",
    buyer_key: "BUYER-SECRET",
    payme_signature: "75e99dbcb25cdfbe1c62f0b9376f4144",
  }).toString(),
  query: new URLSearchParams({ a: ATTEMPT_ID, t }),
  ip: "203.0.113.5",
});

const refundInput = (isFull: boolean) => ({
  refundId: "r1",
  transactionId: "TRAN1655-0000AAAA-BBBBCCCC-DDDDEEEE",
  providerRef: SALE,
  amount: { amountMinor: isFull ? 125_050 : 50_000, currency: "ILS" as const },
  isFull,
  idemKey: "k1",
  priorRefunds: 0,
  invoiceRef: "GG-7K3M9Q-R1",
  reason: "cancellation",
});

paymentProviderContract({
  name: "isracard (synthetic fixtures)",
  build: async (r) => build(r, withClientKey),
  buildUnconfigured: async () =>
    createIsracardProvider({
      env: await makeEnv({
        ...ISRACARD_ENV,
        ISRACARD_MODE: "disabled",
        PAYMENT_PROVIDERS: "mock",
      }),
      fetch: replayFetch([]).fetch,
    }),
  routes,
  authRoutes: [],
  checkout: checkoutInput(),
  createFixture: "none",
  providerRef: `hf:${ATTEMPT_ID}`,
  merchantRef: sellerFingerprint(SELLER),
  states: [
    { fixture: "get-transactions-completed", expected: "succeeded" },
    { fixture: "get-transactions-unpaid", expected: "pending" },
    { fixture: "get-transactions-none", expected: "pending" },
    { fixture: "get-transactions-failed", expected: "failed" },
    { fixture: "get-transactions-authorized", expected: "review" },
    { fixture: "get-transactions-voided", expected: "canceled" },
    { fixture: "get-transactions-refunded", expected: "refunded" },
    {
      fixture: "get-transactions-partial-refund",
      expected: "partially_refunded",
    },
  ],
  notification: {
    good: () => ({
      n: callback(hmacToken("isracard-notify", ATTEMPT_ID)),
      routes: [],
    }),
    bad: () => ({ n: callback("x".repeat(32)), routes: [] }),
  },
  refund: [
    {
      input: refundInput(true),
      fixture: "refund-sale-ok",
      expected: "succeeded",
    },
    {
      input: refundInput(false),
      fixture: "refund-sale-partial",
      expected: "succeeded",
    },
    {
      input: refundInput(true),
      fixture: "refund-sale-refused",
      expected: "ProviderRejectedError",
    },
  ],
  pii: [
    "Test Buyer",
    "buyer@example.com",
    "03-000-0000",
    "000000018",
    "532610",
    "BUYER-SECRET",
    SELLER,
  ],
});

const sale: CreateSaleInput = {
  attemptId: ATTEMPT_ID,
  amount: { amountMinor: 125_050, currency: "ILS" },
  productName: "GG-7K3M9Q · Moonrise",
  installments: 1,
  locale: "he",
  notifyUrl: "https://gallery.example.com/api/payments/isracard/webhook?a=x",
  returnUrl:
    "https://gallery.example.com/api/payments/isracard/return?s=success",
  cancelUrl:
    "https://gallery.example.com/api/payments/isracard/return?s=failed",
};
const pay: PaySaleInput = {
  ...sale,
  saleId: SALE,
  buyerKey: "BUYER-SECRET",
  clientData: "client-data-jwt",
  buyer: null,
  socialId: null,
};

describe("isracard: the pay page", () => {
  it("createCheckout makes no request and opens our pay page with the attempt's token", async () => {
    const { provider, sent } = build([]);
    const session = await provider.createCheckout(checkoutInput());
    expect(sent).toHaveLength(0);
    expect(session.providerRef).toBe(`hf:${ATTEMPT_ID}`);
    if (session.next.kind !== "redirect") throw new Error("no redirect");
    const url = new URL(session.next.url);
    expect(url.origin).toBe("https://gallery.example.com");
    expect(url.pathname).toBe(`/he/checkout/pay/${ATTEMPT_ID}`);
    expect(
      verifyHmacToken("isracard-pay", ATTEMPT_ID, url.searchParams.get("t")),
    ).toBe(true);
  });

  it("createCheckout refuses a currency Isracard is not enabled for", async () => {
    const { provider } = build([]);
    await expect(
      provider.createCheckout(
        checkoutInput({ amount: { amountMinor: 50_000, currency: "USD" } }),
      ),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it("the hosted fields get the JSAPI key, test mode and PayMe's script", () => {
    expect(build([]).provider.hostedFields.client()).toEqual({
      apiKey: "placeholder-jsapi-key",
      testMode: true,
      scriptUrl: "https://cdn.payme.io/hf/v1/hostedfields.js",
    });
  });
});

describe("isracard: generate-sale and pay-sale", () => {
  it("generate-sale sends minor units, our attempt id and a TEST product name, and returns the sale", async () => {
    const { provider, sent } = build(routes("generate-sale-ok"));
    // The fixture's sale id (a recorded fixture carries the sandbox's own).
    const answer = loadFixture("isracard", "generate-sale-ok").exchanges[0]
      ?.response.body as { payme_sale_id: string };
    await expect(provider.hostedFields.createSale(sale)).resolves.toEqual({
      saleId: answer.payme_sale_id,
    });
    expect(sent[0]?.url).toBe("https://sandbox.payme.io/api/generate-sale");
    expect(sent[0]?.body).toMatchObject({
      seller_payme_id: SELLER,
      sale_price: 125_050,
      currency: "ILS",
      transaction_id: ATTEMPT_ID,
      product_name: "TEST – GG-7K3M9Q · Moonrise",
    });
    expect(sent[0]?.bodyText).not.toMatch(/buyer_/);
  });

  it("a refused generate-sale is a rejection (nothing was charged)", async () => {
    const { provider } = build(routes("generate-sale-rejected"));
    await expect(provider.hostedFields.createSale(sale)).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });

  it("pay-sale sends the one-time token and maps completed, 3-D Secure and declined", async () => {
    const done = build(routes("pay-sale-completed"));
    await expect(done.provider.hostedFields.paySale(pay)).resolves.toEqual({
      kind: "completed",
    });
    expect(done.sent[0]?.body).toMatchObject({
      payme_sale_id: SALE,
      buyer_key: "BUYER-SECRET",
      meta_data_jwt: "client-data-jwt",
      sale_price: "125050",
    });

    const challenge = build(routes("pay-sale-3ds"));
    await expect(challenge.provider.hostedFields.paySale(pay)).resolves.toEqual(
      {
        kind: "challenge",
        redirectUrl: "https://sandbox.payme.io/3ds/challenge/placeholder",
      },
    );

    for (const fixture of ["pay-sale-declined", "pay-sale-declined-500"]) {
      const declined = build(routes(fixture));
      await expect(
        declined.provider.hostedFields.paySale(pay),
      ).resolves.toMatchObject({ kind: "declined", code: "301" });
    }
  });

  it("a pay-sale whose outcome is unknown is never a decline (no retry, no second charge)", async () => {
    const bare = build([
      { method: "POST", path: "/api/pay-sale", status: 502 },
    ]);
    const unknown = await bare.provider.hostedFields
      .paySale(pay)
      .catch((e) => e);
    expect(unknown).toBeInstanceOf(ProviderInvalidResponseError);
    expect(unknown.outcomeUnknown).toBe(true);

    const slow = build([
      {
        method: "POST",
        path: "/api/pay-sale",
        status: 0,
        error: timeoutError(),
      },
    ]);
    const timedOut = await slow.provider.hostedFields
      .paySale(pay)
      .catch((e) => e);
    expect(timedOut).toBeInstanceOf(ProviderTimeoutError);
    expect(timedOut.outcomeUnknown).toBe(true);
  });
});

describe("isracard: get-transactions", () => {
  it("looks a payment up by our transaction id, with the seller id", async () => {
    const { provider, sent } = build(routes("get-transactions-completed"));
    const vp = await provider.fetchPayment({
      providerRef: `hf:${ATTEMPT_ID}`,
      attemptId: ATTEMPT_ID,
    });
    expect(sent.map((s) => s.body)).toEqual([
      { seller_payme_id: SELLER, transaction_id: ATTEMPT_ID },
    ]);
    expect(vp).toMatchObject({
      state: "succeeded",
      providerRef: SALE,
      amount: { amountMinor: 125_050, currency: "ILS" },
      last4: "5846",
      approvalCode: "1172408",
    });
  });

  it("falls back to the stored sale id when PayMe does not echo our id", async () => {
    const { provider, sent } = build(routes("get-transactions-by-sale"));
    const vp = await provider.fetchPayment({
      providerRef: SALE,
      attemptId: ATTEMPT_ID,
    });
    expect(sent.map((s) => s.body)).toEqual([
      { seller_payme_id: SELLER, transaction_id: ATTEMPT_ID },
      { seller_payme_id: SELLER, sale_payme_id: SALE },
    ]);
    expect(vp).toMatchObject({
      state: "succeeded",
      echoedReference: ATTEMPT_ID,
    });
  });

  it("a failed lookup is unavailable, never a state", async () => {
    const { provider } = build(routes("get-transactions-error"));
    await expect(
      provider.fetchPayment({
        providerRef: `hf:${ATTEMPT_ID}`,
        attemptId: ATTEMPT_ID,
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("the sweep lists only successful charges in a widened window", async () => {
    const { provider, sent } = build(routes("list-transactions"));
    const listed = await provider.listTransactions?.({
      from: new Date("2026-10-13T00:00:00Z"),
      to: new Date("2026-10-14T00:00:00Z"),
    });
    expect(listed).toEqual([
      {
        transactionId: "TRAN1655-0000AAAA-BBBBCCCC-DDDDEEEE",
        amount: { amountMinor: 125_050, currency: "ILS" },
        returnValue: ATTEMPT_ID,
        lowProfileId: SALE,
      },
    ]);
    // The window is widened by a day each way (PayMe's time zone).
    expect(sent[0]?.body).toMatchObject({
      seller_payme_id: SELLER,
      transaction_created_min: expect.stringMatching(/^2026-10-12/),
      transaction_created_max: expect.stringMatching(/^2026-10-15/),
    });
  });
});

describe("isracard: refunds", () => {
  it("without the partner key (or a sale id) a refund is manual, with no request", async () => {
    const { provider, sent } = build([]);
    await expect(provider.refund(refundInput(true))).resolves.toMatchObject({
      status: "manual_required",
    });
    const keyed = build([], withClientKey);
    await expect(
      keyed.provider.refund({ ...refundInput(true), providerRef: undefined }),
    ).resolves.toMatchObject({ status: "manual_required" });
    expect([...sent, ...keyed.sent]).toHaveLength(0);
  });

  it("a partial refund sends its amount; a full one sends none", async () => {
    const partial = build(routes("refund-sale-partial"), withClientKey);
    await partial.provider.refund(refundInput(false));
    expect(partial.sent[0]?.body).toMatchObject({
      payme_sale_id: SALE,
      sale_refund_amount: 50_000,
    });
    const full = build(routes("refund-sale-ok"), withClientKey);
    await full.provider.refund(refundInput(true));
    expect(full.sent[0]?.body).not.toHaveProperty("sale_refund_amount");
  });
});
