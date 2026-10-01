import { beforeEach, describe, expect, it } from "vitest";
import { liveEnabled, liveVar, MORNING_ENV, makeEnv } from "./support/env";
import {
  loadFixture,
  type ReplayRoute,
  replayFetch,
  routesFrom,
  timeoutError,
} from "./support/replay";
import {
  creditNoteInput,
  receiptInput,
  type TaxDocStep,
  taxDocContract,
} from "./taxdoc.suite";

/**
 * Morning documents adapter and the mock provider on the shared tax-document contract (spec §4.9
 * "Morning"): token, 400/320/330, vatType, payment types, marker search, the UNKNOWN protocol's
 * error classes. No sandbox credentials exist yet: the live block skips cleanly.
 */
const { createMorningTaxDocumentProvider, resetMorningTokenCache } =
  await import("@/server/taxdocs/morning");
const { createMockTaxDocumentProvider, resetMockTaxDocHooks } = await import(
  "@/server/taxdocs/mock"
);
const { TaxDocumentNeedsManualError } = await import("@/server/taxdocs/types");
const {
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderNotConfiguredError,
} = await import("@/server/integrations/http");

const DOC = "6f0c8a2e-1111-4a5b-9c0d-000000000001";
const env = await makeEnv(MORNING_ENV);
const routes = (scenario: string) =>
  routesFrom(loadFixture("morning", scenario));
const token = () => routes("token");

beforeEach(() => resetMorningTokenCache());

function build(r: ReplayRoute[], e = env) {
  // Each adapter instance starts without a cached token (the cache is per process).
  resetMorningTokenCache();
  const replay = replayFetch(r);
  return {
    provider: createMorningTaxDocumentProvider({ env: e, fetch: replay.fetch }),
    sent: replay.sent,
  };
}

const MORNING_STEPS: Record<TaxDocStep, string[]> = {
  "receipt-patur": ["create-receipt"],
  "receipt-murshe": [],
  "find-hit": ["search-found"],
  "find-miss": ["search-empty"],
  "credit-note": ["get-document-320", "create-credit-note"],
};

taxDocContract({
  name: "morning (fixtures)",
  knownMarker: "GG-7K3M9Q/RECEIPT/1",
  build: async (step) => {
    const extra: ReplayRoute[] =
      step === "receipt-murshe"
        ? [
            {
              method: "POST",
              path: "/api/v1/documents",
              status: 201,
              body: { id: DOC, number: 30002, type: 320, url: {} },
            },
          ]
        : MORNING_STEPS[step].flatMap(routes);
    return build([...token(), ...extra]).provider;
  },
});

taxDocContract({
  name: "mock",
  knownMarker: "GG-7K3M9Q/RECEIPT/1",
  build: async (step) => {
    const provider = createMockTaxDocumentProvider({ env: await makeEnv() });
    if (step === "find-hit") {
      resetMockTaxDocHooks({ forget: true });
      await provider.issueReceipt(receiptInput());
    }
    return provider;
  },
});

describe("morning: token", () => {
  it("posts client_credentials to the auth host and caches the token", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("search-empty"),
      ...routes("search-empty"),
    ]);
    await provider.findByMarker?.("x", new Date());
    await provider.findByMarker?.("x", new Date());
    expect(sent[0]?.url).toBe(
      "https://api.sandbox.morning.dev/idp/v1/oauth/token",
    );
    expect(sent[0]?.body).toEqual({
      grant_type: "client_credentials",
      client_id: "placeholder-morning-id",
      client_secret: "placeholder-morning-secret",
    });
    expect(sent.filter((s) => s.path.endsWith("/oauth/token"))).toHaveLength(1);
    expect(sent[1]?.url).toBe(
      "https://sandbox.d.greeninvoice.co.il/api/v1/documents/search",
    );
    expect(sent[1]?.headers.get("authorization")).toBe(
      "Bearer test-morning-access-token",
    );
  });

  it("refuses without credentials", async () => {
    const provider = createMorningTaxDocumentProvider({
      env: await makeEnv(),
      fetch: replayFetch([]).fetch,
    });
    await expect(provider.issueReceipt(receiptInput())).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
  });
});

describe("morning: receipts", () => {
  it("sends the marker as description, type 400, payment type 3 with last 4 digits", async () => {
    const { provider, sent } = build([...token(), ...routes("create-receipt")]);
    const doc = await provider.issueReceipt(receiptInput());
    expect(doc).toMatchObject({
      providerDocId: DOC,
      docNumber: "30001",
      docTypeCode: "400",
      url: "https://example.com/doc/origin.pdf",
    });
    const body = sent[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      description: "GG-7K3M9Q/RECEIPT/1",
      type: 400,
      lang: "he",
      currency: "ILS",
      vatType: 0,
      signed: true,
      client: { name: "Test Buyer", country: "IL", add: false },
      income: [
        {
          description: "Moonrise",
          quantity: 1,
          price: 1200,
          currency: "ILS",
          currencyRate: 1,
          vatType: 0,
        },
        { description: "משלוח", quantity: 1, price: 50.5, vatType: 0 },
      ],
      payment: [
        {
          type: 3,
          price: 1250.5,
          date: "2026-10-01",
          cardNum: "4580",
          dealType: 1,
          currency: "ILS",
        },
      ],
    });
    expect(String(body.remarks)).toContain("GG-7K3M9Q");
    expect(String(body.remarks)).toContain("/he/cancel");
  });

  it("murshe: type 320 with VAT-inclusive rows; exports: vatType 1 and exempt rows", async () => {
    const created = {
      method: "POST",
      path: "/api/v1/documents",
      status: 201,
      body: { id: DOC, number: 1, type: 320 },
    };
    const murshe = build([...token(), created]);
    await murshe.provider.issueReceipt(
      receiptInput({ vatMode: "OSEK_MURSHE" }),
    );
    expect(murshe.sent[1]?.body).toMatchObject({
      type: 320,
      vatType: 0,
      income: [{ vatType: 1 }, { vatType: 1 }],
    });
    const exportDoc = build([...token(), created]);
    await exportDoc.provider.issueReceipt(
      receiptInput({
        vatMode: "OSEK_MURSHE",
        zeroRatedExport: true,
        currency: "USD",
        language: "en",
      }),
    );
    const body = exportDoc.sent[1]?.body as {
      vatType: number;
      income: { vatType: number; currencyRate?: number }[];
      remarks: string;
    };
    expect(body.vatType).toBe(1);
    expect(body.income.every((r) => r.vatType === 2)).toBe(true);
    expect(body.income[0]?.currencyRate).toBeUndefined();
    expect(body.remarks).toContain("/en/cancel");
  });

  it("maps payment types (PayPal 5, Bit/Apple/Google Pay 10 + appType, transfer 4, cash 1, cheque 2, other 11)", async () => {
    const cases = [
      ["paypal", { type: 5, transactionId: "REF" }],
      ["bit", { type: 10, appType: 1 }],
      ["apple_pay", { type: 10, appType: 6 }],
      ["google_pay", { type: 10, appType: 5 }],
      ["transfer", { type: 4 }],
      ["cash", { type: 1 }],
      ["cheque", { type: 2 }],
      ["other", { type: 11 }],
    ] as const;
    for (const [type, expected] of cases) {
      const { provider, sent } = build([
        ...token(),
        {
          method: "POST",
          path: "/api/v1/documents",
          status: 201,
          body: { id: DOC, number: 1, type: 400 },
        },
      ]);
      await provider.issueReceipt(
        receiptInput({
          payment: {
            type,
            amountMinor: 125_050,
            date: "2026-10-01",
            reference: "REF",
          },
        }),
      );
      expect(
        (sent[1]?.body as { payment: unknown[] } | undefined)?.payment[0],
      ).toMatchObject(expected);
    }
  });

  it("card installments: dealType 2 with numPayments", async () => {
    const { provider, sent } = build([...token(), ...routes("create-receipt")]);
    await provider.issueReceipt(
      receiptInput({
        payment: {
          type: "card",
          amountMinor: 125_050,
          date: "2026-10-01",
          reference: "1",
          last4: "4580",
          installments: 3,
        },
      }),
    );
    expect(
      (sent[1]?.body as { payment: unknown[] } | undefined)?.payment[0],
    ).toMatchObject({
      dealType: 2,
      numPayments: 3,
    });
  });

  it("errors follow the exactly-once protocol: 4xx rejected, timeout unknown, 5xx unavailable", async () => {
    const rejected = build([...token(), ...routes("create-rejected")]);
    const e1 = await rejected.provider
      .issueReceipt(receiptInput())
      .catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderRejectedError);
    expect(e1.code).toBe("1003");
    expect(e1.outcomeUnknown).toBe(false);

    const timeout = build([
      ...token(),
      {
        method: "POST",
        path: "/api/v1/documents",
        status: 0,
        error: timeoutError(),
      },
    ]);
    const e2 = await timeout.provider
      .issueReceipt(receiptInput())
      .catch((e) => e);
    expect(e2).toBeInstanceOf(ProviderTimeoutError);
    expect(e2.outcomeUnknown).toBe(true);
    expect(timeout.sent).toHaveLength(2);

    const down = build([
      ...token(),
      { method: "POST", path: "/api/v1/documents", status: 503, body: {} },
    ]);
    await expect(
      down.provider.issueReceipt(receiptInput()),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("morning: marker search, credit notes, PDF", () => {
  it("searches by description within ±7 days and matches the marker exactly", async () => {
    const { provider, sent } = build([...token(), ...routes("search-found")]);
    const doc = await provider.findByMarker?.(
      "GG-7K3M9Q/RECEIPT/1",
      new Date("2026-10-01T12:00:00Z"),
    );
    expect(doc).toMatchObject({
      providerDocId: DOC,
      docNumber: "30001",
      docTypeCode: "400",
    });
    expect(sent[1]?.body).toMatchObject({
      description: "GG-7K3M9Q/RECEIPT/1",
      fromDate: "2026-09-24",
      toDate: "2026-10-08",
    });
    // The fuzzy hit "…/RECEIPT/10" is not returned for "…/RECEIPT/1" and vice versa.
    const other = build([...token(), ...routes("search-found")]);
    expect(
      await other.provider.findByMarker?.("GG-7K3M9Q/RECEIPT/2", new Date()),
    ).toBeNull();
  });

  it("credit note: type 330 linked to the receipt", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("get-document-320"),
      ...routes("create-credit-note"),
    ]);
    await provider.issueCreditNote(creditNoteInput());
    expect(sent[2]?.body).toMatchObject({
      type: 330,
      description: "GG-7K3M9Q/CREDIT_NOTE/1",
      linkedDocumentIds: [DOC],
      income: [{ price: 1250.5, vatType: 1, quantity: 1 }],
      client: { name: "Test Buyer", country: "IL" },
    });
  });

  it("credit note for an osek patur receipt (400) needs a manual document", async () => {
    const { provider, sent } = build([
      ...token(),
      ...routes("get-document-400"),
    ]);
    await expect(
      provider.issueCreditNote(creditNoteInput()),
    ).rejects.toBeInstanceOf(TaxDocumentNeedsManualError);
    expect(
      sent.filter((s) => s.method === "POST" && s.path === "/api/v1/documents"),
    ).toHaveLength(0);
  });

  it("downloads the PDF through the download links", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 test");
    const { provider } = build([
      ...token(),
      ...routes("download-links"),
      { method: "GET", path: "/doc/origin.pdf", status: 200, raw: pdf },
    ]);
    const bytes = await provider.getPdf?.(DOC);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4 test");
  });
});

/** Opt-in live block: `MORNING_CONTRACT=1` with sandbox credentials (none exist yet → skipped). */
const live =
  liveEnabled("MORNING_CONTRACT") &&
  !!liveVar("MORNING_CLIENT_ID") &&
  !!liveVar("MORNING_CLIENT_SECRET");

describe.runIf(live)("morning: live sandbox", () => {
  it("issues a receipt and finds it by marker", async () => {
    const liveEnv = await makeEnv({
      ...MORNING_ENV,
      MORNING_CLIENT_ID: liveVar("MORNING_CLIENT_ID"),
      MORNING_CLIENT_SECRET: liveVar("MORNING_CLIENT_SECRET"),
    });
    const provider = createMorningTaxDocumentProvider({ env: liveEnv });
    const marker = `GG-CONTRACT/RECEIPT/${Date.now()}`;
    const doc = await provider.issueReceipt(
      receiptInput({
        marker,
        payment: {
          type: "transfer",
          amountMinor: 100,
          date: new Date().toISOString().slice(0, 10),
          reference: "CT",
        },
        lines: [
          { description: "Contract check", unitPriceMinor: 100, quantity: 1 },
        ],
      }),
    );
    const found = await provider.findByMarker?.(marker, new Date());
    expect(found?.providerDocId).toBe(doc.providerDocId);
  }, 60_000);
});
