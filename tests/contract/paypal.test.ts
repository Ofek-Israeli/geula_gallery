import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_ID,
  checkoutInput,
  paymentProviderContract,
} from "./payment-provider.suite";
import { liveEnabled, liveVar, makeEnv, PAYPAL_ENV } from "./support/env";
import {
  loadFixture,
  type ReplayRoute,
  replayFetch,
  routesFrom,
} from "./support/replay";

/**
 * PayPal Orders v2 adapter on fixtures that follow the official OpenAPI types (spec §4.9 "PayPal"):
 * every order state, capture PENDING, refund PENDING and getRefund, payer-action extraction, the
 * raw-embedding verify body, token caching, request ids, unique invoice_id, payee merchant_id and
 * refund custom_id. No sandbox credentials exist yet: the live block skips cleanly.
 */
const { createPaypalProvider, resetPaypalTokenCache } = await import(
  "@/server/payments/providers/paypal"
);
const { ProviderRejectedError, ProviderNotConfiguredError } = await import(
  "@/server/integrations/http"
);

const ORDER = "5O190127TN364715T";
const CAPTURE = "3C679366HH908993F";
const REFUND = "1JU08902781691411";
const env = await makeEnv(PAYPAL_ENV);
const routes = (scenario: string) =>
  routesFrom(loadFixture("paypal", scenario));
const token = () => routes("token");

beforeEach(() => resetPaypalTokenCache());

function build(r: ReplayRoute[], e = env) {
  // Each adapter instance starts without a cached token (the cache is per process).
  resetPaypalTokenCache();
  const replay = replayFetch(r);
  return {
    provider: createPaypalProvider({ env: e, fetch: replay.fetch }),
    sent: replay.sent,
    pending: replay.pending,
  };
}

const usdCheckout = checkoutInput({
  amount: { amountMinor: 34_000, currency: "USD" },
  lines: [
    { name: "Moonrise", amount: { amountMinor: 30_000, currency: "USD" } },
  ],
  shipping: { amountMinor: 3_000, currency: "USD" },
  insurance: { amountMinor: 1_000, currency: "USD" },
  shipTo: {
    name: "Test Buyer",
    line1: "1 Main St",
    city: "New York",
    region: "NY",
    postalCode: "10001",
    country: "US",
    phone: "+12125550100",
  },
  locale: "en",
});

const event = (scenario: string) =>
  JSON.stringify(loadFixture("paypal", scenario).exchanges[0]?.request.body);
const signedHeaders = () =>
  new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url":
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "paypal-transmission-id": "69cd13f0-0000-11ef-0000-000000000001",
    "paypal-transmission-sig": "c2lnbmF0dXJl",
    "paypal-transmission-time": "2026-10-01T12:00:06Z",
    "content-type": "application/json",
  });
const verifyRoute = (status: "SUCCESS" | "FAILURE"): ReplayRoute => ({
  method: "POST",
  path: "/v1/notifications/verify-webhook-signature",
  status: 200,
  body: { verification_status: status },
});

paymentProviderContract({
  name: "paypal (fixtures)",
  build: async (r) => build(r),
  buildUnconfigured: async () =>
    createPaypalProvider({
      env: await makeEnv({ PAYPAL_MODE: "disabled" }),
      fetch: replayFetch([]).fetch,
    }),
  routes,
  authRoutes: token(),
  checkout: usdCheckout,
  createFixture: "create-order",
  providerRef: ORDER,
  merchantRef: "TESTMERCHANT01",
  states: [
    { fixture: "order-created", expected: "pending" },
    { fixture: "order-saved", expected: "pending" },
    { fixture: "order-payer-action-required", expected: "pending" },
    { fixture: "order-approved", expected: "requires_capture" },
    { fixture: "order-captured", expected: "succeeded" },
    { fixture: "order-capture-pending", expected: "review" },
    { fixture: "order-capture-declined", expected: "failed" },
    { fixture: "order-capture-failed", expected: "failed" },
    { fixture: "order-refunded", expected: "refunded" },
    { fixture: "order-partially-refunded", expected: "partially_refunded" },
    { fixture: "order-voided", expected: "canceled" },
  ],
  notification: {
    good: () => ({
      n: {
        headers: signedHeaders(),
        rawBody: event("webhook-capture-completed"),
        query: new URLSearchParams(),
        ip: "203.0.113.5",
      },
      routes: [...token(), verifyRoute("SUCCESS")],
    }),
    bad: () => ({
      n: {
        headers: signedHeaders(),
        rawBody: event("webhook-capture-completed"),
        query: new URLSearchParams(),
        ip: "203.0.113.5",
      },
      routes: [...token(), verifyRoute("FAILURE")],
    }),
  },
  refund: [
    {
      input: {
        refundId: "22222222-2222-4222-8222-222222222222",
        transactionId: CAPTURE,
        captureId: CAPTURE,
        amount: { amountMinor: 34_000, currency: "USD" },
        isFull: true,
        idemKey: "refund-idem-1",
        priorRefunds: 0,
        invoiceRef: "GG-7K3M9Q-R1",
        reason: "cancellation",
      },
      fixture: "refund-completed",
      expected: "succeeded",
    },
    {
      input: {
        refundId: "22222222-2222-4222-8222-222222222222",
        transactionId: CAPTURE,
        captureId: CAPTURE,
        amount: { amountMinor: 34_000, currency: "USD" },
        isFull: true,
        idemKey: "refund-idem-2",
        priorRefunds: 0,
        invoiceRef: "GG-7K3M9Q-R1",
        reason: "cancellation",
      },
      fixture: "refund-pending",
      expected: "pending",
    },
  ],
  pii: [
    "buyer@example.com",
    "Test Buyer",
    "seller@example.com",
    "TESTPAYER001",
  ],
});

describe("paypal: create order", () => {
  it("posts intent CAPTURE with custom_id, invoice_id, breakdown, items and the experience context", async () => {
    const { provider, sent } = build([...token(), ...routes("create-order")]);
    const session = await provider.createCheckout(usdCheckout);
    expect(session.next.url).toBe(
      `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}`,
    );
    const create = sent[1];
    expect(create?.path).toBe("/v2/checkout/orders");
    expect(create?.headers.get("paypal-request-id")).toBe(usdCheckout.idemKey);
    expect(create?.headers.get("authorization")).toBe(
      "Bearer test-access-token-1",
    );
    expect(create?.body).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: ATTEMPT_ID,
          invoice_id: "GG-7K3M9Q-1",
          amount: {
            currency_code: "USD",
            value: "340.00",
            breakdown: {
              item_total: { currency_code: "USD", value: "300.00" },
              shipping: { currency_code: "USD", value: "30.00" },
              insurance: { currency_code: "USD", value: "10.00" },
            },
          },
          items: [
            {
              name: "Moonrise",
              quantity: "1",
              category: "PHYSICAL_GOODS",
              unit_amount: { currency_code: "USD", value: "300.00" },
            },
          ],
          shipping: {
            type: "SHIPPING",
            name: { full_name: "Test Buyer" },
            address: {
              country_code: "US",
              admin_area_2: "New York",
              postal_code: "10001",
            },
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            landing_page: "NO_PREFERENCE",
            shipping_preference: "SET_PROVIDED_ADDRESS",
            locale: "en-US",
            return_url: usdCheckout.returnUrl,
            cancel_url: usdCheckout.cancelUrl,
          },
        },
      },
    });
  });

  it("uses a unique invoice_id per attempt and NO_SHIPPING for pickup", async () => {
    const { provider, sent } = build([...token(), ...routes("create-order")]);
    await provider.createCheckout({
      ...usdCheckout,
      attemptSeq: 3,
      shipTo: undefined,
    });
    const body = sent[1]?.body as {
      purchase_units: { invoice_id: string; shipping?: unknown }[];
      payment_source: {
        paypal: { experience_context: { shipping_preference: string } };
      };
    };
    expect(body.purchase_units[0]?.invoice_id).toBe("GG-7K3M9Q-3");
    expect(body.purchase_units[0]?.shipping).toBeUndefined();
    expect(
      body.payment_source.paypal.experience_context.shipping_preference,
    ).toBe("NO_SHIPPING");
  });

  it("omits the breakdown when the lines do not add up to the amount", async () => {
    const { provider, sent } = build([...token(), ...routes("create-order")]);
    await provider.createCheckout({
      ...usdCheckout,
      amount: { amountMinor: 35_000, currency: "USD" },
    });
    const pu = (
      sent[1]?.body as { purchase_units: Record<string, unknown>[] } | undefined
    )?.purchase_units[0];
    expect(pu?.amount).toEqual({ currency_code: "USD", value: "350.00" });
    expect(pu?.items).toBeUndefined();
  });

  it("caches the OAuth token across calls and refreshes it after a 401", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("order-approved"),
      ...routes("order-approved"),
      {
        method: "GET",
        path: `/v2/checkout/orders/${ORDER}`,
        status: 401,
        body: { error: "invalid_token" },
      },
      {
        ...token()[0],
        body: { access_token: "test-access-token-2", expires_in: 32400 },
      } as ReplayRoute,
      ...routes("order-approved"),
    ]);
    await provider.fetchPayment({ providerRef: ORDER, attemptId: ATTEMPT_ID });
    await provider.fetchPayment({ providerRef: ORDER, attemptId: ATTEMPT_ID });
    expect(sent.filter((s) => s.path === "/v1/oauth2/token")).toHaveLength(1);
    await provider.fetchPayment({ providerRef: ORDER, attemptId: ATTEMPT_ID });
    expect(sent.filter((s) => s.path === "/v1/oauth2/token")).toHaveLength(2);
    expect(sent.at(-1)?.headers.get("authorization")).toBe(
      "Bearer test-access-token-2",
    );
    expect(sent[0]?.bodyText).toBe("grant_type=client_credentials");
    expect(sent[0]?.headers.get("authorization")).toMatch(/^Basic /);
  });

  it("a payee merchant_id other than PAYPAL_MERCHANT_ID is surfaced for the mismatch check", async () => {
    const other = await makeEnv({
      ...PAYPAL_ENV,
      PAYPAL_MERCHANT_ID: "OTHERMERCHANT",
    });
    const { provider } = build(
      [...token(), ...routes("order-captured")],
      other,
    );
    const vp = await provider.fetchPayment({
      providerRef: ORDER,
      attemptId: ATTEMPT_ID,
    });
    expect(vp.merchantRef).toBe("TESTMERCHANT01");
    expect(vp.merchantRef).not.toBe(provider.merchantRef());
  });
});

describe("paypal: capture", () => {
  it("captures with PayPal-Request-Id and Prefer: return=representation", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("capture-completed"),
    ]);
    const vp = await provider.capture?.({
      providerRef: ORDER,
      idemKey: "capture-key-1",
    });
    expect(vp).toMatchObject({
      state: "succeeded",
      captureId: CAPTURE,
      transactionId: CAPTURE,
      amount: { amountMinor: 34_000, currency: "USD" },
      echoedReference: ATTEMPT_ID,
    });
    expect(sent[1]?.headers.get("paypal-request-id")).toBe("capture-key-1");
    expect(sent[1]?.headers.get("prefer")).toBe("return=representation");
  });

  it("ORDER_ALREADY_CAPTURED re-reads the order", async () => {
    const { provider } = build([
      ...token(),
      ...routes("capture-already-captured"),
    ]);
    const vp = await provider.capture?.({ providerRef: ORDER, idemKey: "k" });
    expect(vp?.state).toBe("succeeded");
  });

  it("a declined instrument fails the attempt instead of looping on requires_capture", async () => {
    const { provider } = build([
      ...token(),
      ...routes("capture-instrument-declined"),
    ]);
    const vp = await provider.capture?.({ providerRef: ORDER, idemKey: "k" });
    expect(vp?.state).toBe("failed");
  });
});

describe("paypal: refunds", () => {
  const input = {
    refundId: "22222222-2222-4222-8222-222222222222",
    transactionId: CAPTURE,
    captureId: CAPTURE,
    amount: { amountMinor: 10_000, currency: "USD" as const },
    isFull: false,
    idemKey: "refund-idem-1",
    priorRefunds: 0,
    invoiceRef: "GG-7K3M9Q-R1",
    reason: "cancellation",
  };

  it("sends amount, custom_id = refund id and invoice_id, never note_to_payer", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("refund-completed"),
    ]);
    const out = await provider.refund(input);
    expect(out.providerRefundId).toBe(REFUND);
    expect(sent[1]?.path).toBe(`/v2/payments/captures/${CAPTURE}/refund`);
    expect(sent[1]?.headers.get("paypal-request-id")).toBe("refund-idem-1");
    expect(sent[1]?.body).toEqual({
      amount: { currency_code: "USD", value: "100.00" },
      custom_id: input.refundId,
      invoice_id: "GG-7K3M9Q-R1",
    });
  });

  it("a FAILED refund is a rejection", async () => {
    const { provider } = build([
      ...token(),
      {
        method: "POST",
        path: `/v2/payments/captures/${CAPTURE}/refund`,
        status: 201,
        body: { id: REFUND, status: "FAILED" },
      },
    ]);
    await expect(provider.refund(input)).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });

  it("getRefund by id; 404 → not_found", async () => {
    const found = build([...token(), ...routes("refund-get")]);
    expect(
      await found.provider.getRefund?.({
        providerRefundId: REFUND,
        refundId: input.refundId,
      }),
    ).toEqual({ status: "succeeded", providerRefundId: REFUND });
    const missing = build([
      ...token(),
      {
        method: "GET",
        path: `/v2/payments/refunds/${REFUND}`,
        status: 404,
        body: { name: "RESOURCE_NOT_FOUND" },
      },
    ]);
    expect(
      await missing.provider.getRefund?.({
        providerRefundId: REFUND,
        refundId: input.refundId,
      }),
    ).toEqual({ status: "not_found" });
  });

  it("getRefund without a stored id finds our custom_id on the capture's order", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("capture-get"),
      ...routes("order-partially-refunded"),
    ]);
    expect(
      await provider.getRefund?.({
        refundId: input.refundId,
        captureId: CAPTURE,
      }),
    ).toEqual({ status: "succeeded", providerRefundId: REFUND });
    expect(sent.map((s) => s.path)).toEqual([
      "/v1/oauth2/token",
      `/v2/payments/captures/${CAPTURE}`,
      `/v2/checkout/orders/${ORDER}`,
    ]);
    const other = build([
      ...token(),
      ...routes("capture-get"),
      ...routes("order-partially-refunded"),
    ]);
    expect(
      await other.provider.getRefund?.({
        refundId: "another-refund",
        captureId: CAPTURE,
      }),
    ).toEqual({ status: "not_found" });
  });
});

describe("paypal: webhooks", () => {
  it("embeds the raw event byte for byte in the verify postback", async () => {
    const raw = `{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"1.10"},"x":1.0}}`;
    const { provider, sent } = build([...token(), verifyRoute("SUCCESS")]);
    expect(
      await provider.authenticateNotification({
        headers: signedHeaders(),
        rawBody: raw,
        query: new URLSearchParams(),
        ip: "203.0.113.5",
      }),
    ).toBe(true);
    const body = sent[1]?.bodyText ?? "";
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      auth_algo: "SHA256withRSA",
      transmission_id: "69cd13f0-0000-11ef-0000-000000000001",
      webhook_id: "WH-PLACEHOLDER",
    });
  });

  it("rejects missing headers, non-object bodies and a missing webhook id without a network call", async () => {
    const { provider, sent } = build([]);
    const n = (headers: Headers, rawBody: string) => ({
      headers,
      rawBody,
      query: new URLSearchParams(),
      ip: "203.0.113.5",
    });
    expect(
      await provider.authenticateNotification(n(new Headers(), "{}")),
    ).toBe(false);
    expect(
      await provider.authenticateNotification(n(signedHeaders(), "[1]")),
    ).toBe(false);
    expect(
      await provider.authenticateNotification(
        n(signedHeaders(), '{"a":1},"webhook_id":"x"'),
      ),
    ).toBe(false);
    const noId = createPaypalProvider({
      env: await makeEnv({ ...PAYPAL_ENV, PAYPAL_WEBHOOK_ID: undefined }),
      fetch: replayFetch([]).fetch,
    });
    expect(await noId.authenticateNotification(n(signedHeaders(), "{}"))).toBe(
      false,
    );
    expect(sent).toHaveLength(0);
  });

  it("parses capture and refund events into hints", () => {
    const { provider } = build([]);
    const capture = provider.parseNotification({
      headers: new Headers(),
      rawBody: event("webhook-capture-completed"),
      query: new URLSearchParams(),
    });
    expect(capture).toMatchObject({
      eventKey: "WH-TEST-0001",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      attemptId: ATTEMPT_ID,
      providerRef: ORDER,
    });
    const refund = provider.parseNotification({
      headers: new Headers(),
      rawBody: event("webhook-capture-refunded"),
      query: new URLSearchParams(),
    });
    expect(refund).toMatchObject({
      eventKey: "WH-TEST-0002",
      eventType: "PAYMENT.CAPTURE.REFUNDED",
      refundCustomId: "22222222-2222-4222-8222-222222222222",
    });
    expect(refund.attemptId).toBeUndefined();
  });

  it("refuses to work without credentials", async () => {
    const provider = createPaypalProvider({
      env: await makeEnv({ PAYPAL_MODE: "disabled" }),
      fetch: replayFetch([]).fetch,
    });
    await expect(
      provider.capture?.({ providerRef: ORDER, idemKey: "k" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});

/** Opt-in live block: `PAYPAL_CONTRACT=1` with sandbox credentials (none exist yet → skipped). */
const live =
  liveEnabled("PAYPAL_CONTRACT") &&
  !!liveVar("PAYPAL_CLIENT_ID") &&
  !!liveVar("PAYPAL_CLIENT_SECRET") &&
  !!liveVar("PAYPAL_MERCHANT_ID");

describe.runIf(live)("paypal: live sandbox", () => {
  it("creates an order and reads it back as pending", async () => {
    const liveEnv = await makeEnv({
      PAYPAL_MODE: "sandbox",
      PAYPAL_CLIENT_ID: liveVar("PAYPAL_CLIENT_ID"),
      PAYPAL_CLIENT_SECRET: liveVar("PAYPAL_CLIENT_SECRET"),
      PAYPAL_MERCHANT_ID: liveVar("PAYPAL_MERCHANT_ID"),
      PAYPAL_WEBHOOK_ID: liveVar("PAYPAL_WEBHOOK_ID"),
    });
    const provider = createPaypalProvider({ env: liveEnv });
    const session = await provider.createCheckout({
      ...usdCheckout,
      idemKey: crypto.randomUUID(),
      orderNumber: `GG-CT${Date.now().toString(36).toUpperCase()}`,
    });
    const vp = await provider.fetchPayment({
      providerRef: session.providerRef,
      attemptId: ATTEMPT_ID,
    });
    expect(vp.state).toBe("pending");
  }, 60_000);
});
