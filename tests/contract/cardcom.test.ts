import { describe, expect, it } from "vitest";
import {
  ATTEMPT_ID,
  checkoutInput,
  paymentProviderContract,
} from "./payment-provider.suite";
import { CARDCOM_ENV, liveEnabled, liveVar, makeEnv } from "./support/env";
import {
  loadFixture,
  type ReplayRoute,
  replayFetch,
  routesFrom,
  timeoutError,
} from "./support/replay";

/**
 * Cardcom LowProfile v11 adapter on fixtures (spec §4.9 "Cardcom"): request builder, GetLpResult
 * map, token auth, redaction, refunds, ListTransactions; plus the opt-in live block
 * (`CARDCOM_CONTRACT=1 npm run test:contract`, test terminal from `.env.local`).
 */
const { createCardcomProvider } = await import(
  "@/server/payments/providers/cardcom"
);
const { hmacToken } = await import("@/server/security/tokens");
const {
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderNotConfiguredError,
} = await import("@/server/integrations/http");

const LP = "a1b2c3d4-0000-4000-8000-0000000000aa";
const env = await makeEnv(CARDCOM_ENV);
const withPassword = await makeEnv({
  ...CARDCOM_ENV,
  CARDCOM_API_PASSWORD: "placeholder-api-password",
});
const routes = (scenario: string) =>
  routesFrom(loadFixture("cardcom", scenario));

function build(r: ReplayRoute[], e = env) {
  const replay = replayFetch(r);
  return {
    provider: createCardcomProvider({ env: e, fetch: replay.fetch }),
    sent: replay.sent,
    pending: replay.pending,
  };
}

const paidBody = () =>
  JSON.stringify(
    loadFixture("cardcom", "getlpresult-paid-ils").exchanges[0]?.response.body,
  );
const notification = (t: string) => ({
  headers: new Headers({ "content-type": "application/json" }),
  rawBody: paidBody(),
  query: new URLSearchParams({ a: ATTEMPT_ID, t }),
  ip: "203.0.113.5",
});

paymentProviderContract({
  name: "cardcom (fixtures)",
  build: async (r) => build(r),
  buildUnconfigured: async () =>
    createCardcomProvider({
      env: await makeEnv({ CARDCOM_MODE: "disabled" }),
      fetch: replayFetch([]).fetch,
    }),
  routes,
  authRoutes: [],
  checkout: checkoutInput(),
  createFixture: "create-ok",
  providerRef: LP,
  merchantRef: "1000",
  states: [
    { fixture: "getlpresult-paid-ils", expected: "succeeded" },
    { fixture: "getlpresult-paid-usd", expected: "succeeded" },
    { fixture: "getlpresult-unpaid", expected: "pending" },
    { fixture: "getlpresult-declined", expected: "pending" },
  ],
  notification: {
    good: () => ({
      n: notification(hmacToken("cardcom-notify", ATTEMPT_ID)),
      routes: [],
    }),
    bad: () => ({ n: notification("x".repeat(32)), routes: [] }),
  },
  refund: [
    {
      input: {
        refundId: "r1",
        transactionId: "7654321",
        amount: { amountMinor: 125_050, currency: "ILS" },
        isFull: true,
        idemKey: "k1",
        priorRefunds: 0,
        invoiceRef: "GG-7K3M9Q-R1",
        reason: "cancellation",
      },
      fixture: "",
      expected: "manual_required",
    },
  ],
  pii: [
    "buyer@example.com",
    "Test Buyer",
    "000000018",
    "test-card-token-0000",
    "458045",
    "03-000-0000",
  ],
});

describe("cardcom: LowProfile/Create request", () => {
  it("sends ReturnValue, ISOCoinId, major-unit amount and the redirect URLs, without nulls", async () => {
    const { provider, sent } = build(routes("create-ok"));
    await provider.createCheckout(checkoutInput());
    const body = sent[0]?.body as Record<string, unknown>;
    expect(sent[0]?.path).toBe("/api/v11/LowProfile/Create");
    expect(body).toMatchObject({
      TerminalNumber: 1000,
      ApiName: "placeholder-api-name",
      Operation: "ChargeOnly",
      ReturnValue: ATTEMPT_ID,
      Amount: 1250.5,
      ISOCoinId: 1,
      Language: "he",
      SuccessRedirectUrl:
        "https://gallery.example.com/api/payments/x/return?s=success",
      FailedRedirectUrl:
        "https://gallery.example.com/api/payments/x/return?s=failed",
      CancelRedirectUrl:
        "https://gallery.example.com/api/payments/x/return?s=cancel",
      WebHookUrl: "https://gallery.example.com/api/payments/x/webhook",
      AdvancedDefinition: { ThreeDSecureState: "Enabled", MaxNumOfPayments: 1 },
    });
    expect(sent[0]?.bodyText).not.toContain("null");
    expect(String(body.ProductName)).toContain("Moonrise");
    expect(String(body.ProductName)).toContain("GG-7K3M9Q");
  });

  it("never sends buyer data in TEST mode, and prefills only in LIVE mode", async () => {
    const test = build(routes("create-ok"));
    await test.provider.createCheckout(checkoutInput());
    expect(test.sent[0]?.bodyText).not.toMatch(
      /buyer@example\.com|Test Buyer|03-000-0000/,
    );
    expect(test.sent[0]?.body).not.toHaveProperty("UIDefinition");

    const live = build(
      routes("create-ok"),
      await makeEnv({
        ...CARDCOM_ENV,
        CARDCOM_MODE: "live",
        CARDCOM_API_PASSWORD: "placeholder-api-password",
        DEMO_MODE: "false",
      }),
    );
    await live.provider.createCheckout(checkoutInput());
    expect(live.sent[0]?.body).toMatchObject({
      UIDefinition: {
        CardOwnerNameValue: "Test Buyer",
        CardOwnerEmailValue: "buyer@example.com",
      },
    });
  });

  it("offers installments only for IL + ILS with maxInstallments > 1", async () => {
    const cases: [Parameters<typeof checkoutInput>[0], number][] = [
      [{ maxInstallments: 6 }, 6],
      [{ maxInstallments: 1 }, 1],
      [
        {
          maxInstallments: 6,
          shipTo: {
            name: "B",
            line1: "1 Main St",
            city: "New York",
            country: "US",
            phone: "+12125550100",
          },
        },
        1,
      ],
    ];
    for (const [overrides, expected] of cases) {
      const { provider, sent } = build(routes("create-ok"));
      await provider.createCheckout(checkoutInput(overrides));
      expect(
        (
          sent[0]?.body as
            | { AdvancedDefinition: { MaxNumOfPayments: number } }
            | undefined
        )?.AdvancedDefinition.MaxNumOfPayments,
      ).toBe(expected);
    }
  });

  it("uses ISOCoinId 2 for USD only when CARDCOM_CURRENCIES allows it", async () => {
    const usd = checkoutInput({
      amount: { amountMinor: 34_000, currency: "USD" },
      lines: [
        { name: "Moonrise", amount: { amountMinor: 30_000, currency: "USD" } },
      ],
      shipping: { amountMinor: 3_000, currency: "USD" },
      insurance: { amountMinor: 1_000, currency: "USD" },
    });
    const refused = build([]);
    await expect(refused.provider.createCheckout(usd)).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
    expect(refused.sent).toHaveLength(0);

    const ok = build(
      routes("create-ok"),
      await makeEnv({ ...CARDCOM_ENV, CARDCOM_CURRENCIES: "ILS,USD" }),
    );
    await ok.provider.createCheckout(usd);
    expect(ok.sent[0]?.body).toMatchObject({ ISOCoinId: 2, Amount: 340 });
  });

  it("maps the live 603 refusal to ProviderRejectedError with the Cardcom code", async () => {
    const { provider } = build(routes("create-rejected"));
    const error = await provider
      .createCheckout(checkoutInput())
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(error.code).toBe("603");
    expect(error.status).toBe(401);
  });

  it("treats a timeout on Create as outcome unknown", async () => {
    const { provider } = build([
      {
        method: "POST",
        path: "/api/v11/LowProfile/Create",
        status: 0,
        error: timeoutError(),
      },
    ]);
    const error = await provider
      .createCheckout(checkoutInput())
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(error.outcomeUnknown).toBe(true);
  });
});

describe("cardcom: GetLpResult", () => {
  it("queries with terminal, ApiName and LowProfileId", async () => {
    const { provider, sent } = build(routes("getlpresult-unpaid"));
    await provider.fetchPayment({ providerRef: LP, attemptId: ATTEMPT_ID });
    expect(sent[0]?.body).toEqual({
      TerminalNumber: 1000,
      ApiName: "placeholder-api-name",
      LowProfileId: LP,
    });
  });

  it("returns card details and minor units for a paid ILS LowProfile", async () => {
    const { provider } = build(routes("getlpresult-paid-ils"));
    const vp = await provider.fetchPayment({
      providerRef: LP,
      attemptId: ATTEMPT_ID,
    });
    expect(vp).toMatchObject({
      state: "succeeded",
      amount: { amountMinor: 125_050, currency: "ILS" },
      transactionId: "7654321",
      last4: "4580",
      approvalCode: "0012345",
      installments: 1,
      isForeignCard: false,
      method: "card",
    });
  });

  it("maps USD and foreign cards", async () => {
    const { provider } = build(routes("getlpresult-paid-usd"));
    const vp = await provider.fetchPayment({
      providerRef: LP,
      attemptId: ATTEMPT_ID,
    });
    expect(vp.amount).toEqual({ amountMinor: 34_000, currency: "USD" });
    expect(vp.isForeignCard).toBe(true);
    expect(vp.installments).toBe(3);
  });

  it("an unknown LowProfileId is a clear rejection (finalize reschedules)", async () => {
    const { provider } = build(routes("getlpresult-not-found"));
    await expect(
      provider.fetchPayment({ providerRef: LP, attemptId: ATTEMPT_ID }),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });
});

describe("cardcom: notifications", () => {
  it("rejects a missing token or attempt id without any network call", async () => {
    const { provider, sent } = build([]);
    for (const query of ["", `a=${ATTEMPT_ID}`, `t=${"x".repeat(32)}`]) {
      expect(
        await provider.authenticateNotification({
          headers: new Headers(),
          rawBody: "{}",
          query: new URLSearchParams(query),
          ip: "203.0.113.5",
        }),
      ).toBe(false);
    }
    // A token for another attempt is not valid for this one.
    expect(
      await provider.authenticateNotification({
        headers: new Headers(),
        rawBody: "{}",
        query: new URLSearchParams({
          a: ATTEMPT_ID,
          t: hmacToken("cardcom-notify", "another-attempt"),
        }),
        ip: "203.0.113.5",
      }),
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("builds cc:<LowProfileId>:<TranzactionId|none>:<ResponseCode> event keys", () => {
    const { provider } = build([]);
    const paid = provider.parseNotification({
      headers: new Headers(),
      rawBody: paidBody(),
      query: new URLSearchParams({ a: ATTEMPT_ID, t: "x" }),
    });
    expect(paid.eventKey).toBe(`cc:${LP}:7654321:0`);
    expect(paid.attemptId).toBe(ATTEMPT_ID);
    expect(paid.providerRef).toBe(LP);
    const garbage = provider.parseNotification({
      headers: new Headers(),
      rawBody: "not json",
      query: new URLSearchParams({ a: ATTEMPT_ID }),
    });
    expect(garbage.eventKey).toBe("cc:unknown:none:na");
  });
});

describe("cardcom: refunds", () => {
  const input = {
    refundId: "r1",
    transactionId: "7654321",
    amount: { amountMinor: 50_000, currency: "ILS" as const },
    isFull: false,
    idemKey: "k1",
    priorRefunds: 0,
    invoiceRef: "GG-7K3M9Q-R1",
    reason: "cancellation",
  };

  it("sends PartialSum and AllowMultipleRefunds=false for the first partial refund", async () => {
    const { provider, sent } = build(routes("refund-ok"), withPassword);
    const out = await provider.refund(input);
    expect(out).toMatchObject({
      status: "succeeded",
      providerRefundId: "7654399",
    });
    expect(sent[0]?.body).toMatchObject({
      ApiName: "placeholder-api-name",
      ApiPassword: "placeholder-api-password",
      TransactionId: 7654321,
      PartialSum: 500,
      AllowMultipleRefunds: false,
      CancelOnly: false,
    });
    expect(JSON.stringify(out.rawRedacted)).not.toContain(
      "placeholder-api-password",
    );
  });

  it("allows multiple refunds after the first and omits PartialSum for a full refund", async () => {
    const { provider, sent } = build(routes("refund-ok"), withPassword);
    await provider.refund({ ...input, isFull: true, priorRefunds: 1 });
    expect(sent[0]?.body).toMatchObject({ AllowMultipleRefunds: true });
    expect(sent[0]?.body).not.toHaveProperty("PartialSum");
  });

  it("any non-zero ResponseCode is a rejection (recorded as FAILED)", async () => {
    const { provider } = build(routes("refund-refused"), withPassword);
    const error = await provider.refund(input).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(error.code).toBe("5040");
  });

  it("a timeout leaves the outcome unknown (no automatic retry of the POST)", async () => {
    const { provider, sent } = build(
      [
        {
          method: "POST",
          path: "/api/v11/Transactions/RefundByTransactionId",
          status: 0,
          error: timeoutError(),
        },
      ],
      withPassword,
    );
    const error = await provider.refund(input).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(sent).toHaveLength(1);
  });
});

describe("cardcom: ListTransactions", () => {
  it("needs the ApiPassword", async () => {
    const { provider } = build([]);
    await expect(
      provider.listTransactions?.({ from: new Date(), to: new Date() }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("pages with DDMMYYYY dates and returns charges only", async () => {
    const { provider, sent } = build(routes("list-transactions"), withPassword);
    const list = await provider.listTransactions?.({
      from: new Date("2026-09-30T21:30:00Z"),
      to: new Date("2026-10-01T10:00:00Z"),
    });
    expect(sent[0]?.body).toMatchObject({
      FromDate: "01102026",
      ToDate: "01102026",
      TranStatus: "Success",
      Page: 1,
    });
    expect(list).toEqual([
      {
        transactionId: "7654321",
        amount: { amountMinor: 125_050, currency: "ILS" },
      },
      {
        transactionId: "7654322",
        amount: { amountMinor: 34_000, currency: "USD" },
      },
    ]);
  });
});

/**
 * Opt-in live block (spec §10.5): `CARDCOM_CONTRACT=1 npm run test:contract` with the test-terminal
 * values in `.env.local`. Create ₪1 → GetLpResult is `pending`. Skips cleanly otherwise.
 */
const live =
  liveEnabled("CARDCOM_CONTRACT") &&
  !!liveVar("CARDCOM_TERMINAL_NUMBER") &&
  !!liveVar("CARDCOM_API_NAME");

describe.runIf(live)("cardcom: live test terminal", () => {
  it("Create ₪1 → GetLpResult pending", async () => {
    const liveEnv = await makeEnv({
      CARDCOM_MODE: "test",
      CARDCOM_TERMINAL_NUMBER: liveVar("CARDCOM_TERMINAL_NUMBER"),
      CARDCOM_API_NAME: liveVar("CARDCOM_API_NAME"),
      CARDCOM_BASE_URL: liveVar("CARDCOM_BASE_URL"),
    });
    const provider = createCardcomProvider({ env: liveEnv });
    const session = await provider.createCheckout(
      checkoutInput({
        amount: { amountMinor: 100, currency: "ILS" },
        lines: [
          {
            name: "Contract check",
            amount: { amountMinor: 100, currency: "ILS" },
          },
        ],
        shipping: { amountMinor: 0, currency: "ILS" },
        insurance: { amountMinor: 0, currency: "ILS" },
        buyer: null,
      }),
    );
    expect(new URL(session.next.url).protocol).toBe("https:");
    const vp = await provider.fetchPayment({
      providerRef: session.providerRef,
      attemptId: ATTEMPT_ID,
    });
    expect(vp.state).toBe("pending");
  }, 60_000);
});
