import { describe, expect, it } from "vitest";
import {
  buildCardcomDocument,
  buildCreateRequest,
  cardcomAmountToMinor,
  cardcomDate,
  cardcomProductName,
  currencyFromCoinId,
  mapGetLpResult,
  notificationEventKey,
  parseCardcomBody,
  parseListTransactions,
  redactCardcom,
  stripNulls,
} from "@/server/payments/providers/cardcom-map";
import type { CreateCheckoutInput } from "@/server/payments/types";

/** Spec §10.1 `cardcom-map`: every GetLpResult state and mismatch, redaction, parsing helpers. */
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const tx = {
  ResponseCode: 0,
  TranzactionId: 7654321,
  TerminalNumber: 1000,
  Amount: 1250.5,
  CoinId: 1,
  Last4CardDigitsString: "4580",
  ApprovalNumber: "0012345",
  NumberOfPayments: 1,
  CardOwnerEmail: "buyer@example.com",
  Token: "test-card-token-0000",
};
const paid = {
  ResponseCode: 0,
  TerminalNumber: 1000,
  LowProfileId: "lp-1",
  TranzactionId: 7654321,
  ReturnValue: ATTEMPT,
  Operation: "ChargeOnly",
  UIValues: { CardOwnerName: "Test Buyer" },
  TranzactionInfo: tx,
};

describe("mapGetLpResult", () => {
  it("succeeds only with ResponseCode 0, ChargeOnly, TranzactionInfo.ResponseCode 0 and TranzactionId > 0", () => {
    expect(mapGetLpResult(paid)).toMatchObject({
      state: "succeeded",
      amount: { amountMinor: 125_050, currency: "ILS" },
      echoedReference: ATTEMPT,
      merchantRef: "1000",
      transactionId: "7654321",
    });
    const pendings = [
      { ...paid, ResponseCode: 1 },
      { ...paid, Operation: "ChargeAndCreateToken" },
      { ...paid, Operation: null },
      { ...paid, TranzactionInfo: null },
      { ...paid, TranzactionInfo: { ...tx, ResponseCode: 33 } },
      {
        ...paid,
        TranzactionId: 0,
        TranzactionInfo: { ...tx, TranzactionId: 0 },
      },
      {},
      null,
      "garbage",
    ];
    for (const raw of pendings) {
      const vp = mapGetLpResult(raw);
      expect(vp.state).toBe("pending");
      expect(vp.amount).toBeNull();
    }
  });

  it("keeps the verification fields on pending results", () => {
    expect(mapGetLpResult({ ...paid, ResponseCode: 1 })).toMatchObject({
      echoedReference: ATTEMPT,
      merchantRef: "1000",
    });
  });

  it("surfaces mismatches for finalize: other reference, terminal, coin or amount", () => {
    expect(
      mapGetLpResult({ ...paid, ReturnValue: "other" }).echoedReference,
    ).toBe("other");
    expect(mapGetLpResult({ ...paid, TerminalNumber: 2000 }).merchantRef).toBe(
      "2000",
    );
    expect(
      mapGetLpResult({ ...paid, TranzactionInfo: { ...tx, CoinId: 2 } }).amount,
    ).toEqual({ amountMinor: 125_050, currency: "USD" });
    expect(
      mapGetLpResult({ ...paid, TranzactionInfo: { ...tx, CoinId: 978 } })
        .amount,
    ).toBeNull();
    expect(
      mapGetLpResult({ ...paid, TranzactionInfo: { ...tx, Amount: 10.555 } })
        .amount,
    ).toBeNull();
  });

  it("maps wallets from ExternalPaymentVector and gateway documents", () => {
    const vp = mapGetLpResult({
      ...paid,
      ExternalPaymentVector: "Bit",
      DocumentInfo: {
        ResponseCode: 0,
        DocumentType: "Receipt",
        DocumentNumber: 1001,
        DocumentUrl: "https://example.com/d",
      },
    });
    expect(vp.method).toBe("bit");
    expect(vp.gatewayDocument).toEqual({
      type: "Receipt",
      number: "1001",
      url: "https://example.com/d",
    });
  });
});

describe("amounts and coins", () => {
  it("converts decimals to minor units and rejects more than 2 places", () => {
    expect(cardcomAmountToMinor(1)).toBe(100);
    expect(cardcomAmountToMinor(1250.5)).toBe(125_050);
    expect(cardcomAmountToMinor(0.1 + 0.2)).toBe(30);
    expect(cardcomAmountToMinor(10.555)).toBeNull();
    expect(cardcomAmountToMinor(-1)).toBeNull();
    expect(cardcomAmountToMinor("12")).toBeNull();
    expect(cardcomAmountToMinor(Number.NaN)).toBeNull();
  });

  it("maps coin ids", () => {
    expect(currencyFromCoinId(1)).toBe("ILS");
    expect(currencyFromCoinId(2)).toBe("USD");
    expect(currencyFromCoinId(3)).toBeNull();
  });
});

describe("redactCardcom", () => {
  it("drops CardOwner*, Token*, UIValues, CardInfo, card digits and credentials", () => {
    const out = JSON.stringify(
      redactCardcom({
        ...paid,
        ApiName: "x",
        ApiPassword: "y",
        TokenInfo: { Token: "t" },
        TranzactionInfo: {
          ...tx,
          CardInfo: "Israeli",
          FirstCardDigits: 458045,
          CardMonth: 1,
          CardYear: 2030,
        },
      }),
    );
    for (const s of [
      "buyer@example.com",
      "Test Buyer",
      "test-card-token",
      "ApiName",
      "ApiPassword",
      "458045",
      "CardInfo",
      "UIValues",
      "CardYear",
    ]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain("4580");
    expect(out).toContain(ATTEMPT);
  });
});

describe("request helpers", () => {
  const input: CreateCheckoutInput = {
    attemptId: ATTEMPT,
    attemptSeq: 1,
    orderId: "o",
    orderNumber: "GG-7K3M9Q",
    amount: { amountMinor: 100, currency: "ILS" },
    lines: [
      { name: "Moonrise", amount: { amountMinor: 100, currency: "ILS" } },
    ],
    shipping: { amountMinor: 0, currency: "ILS" },
    insurance: { amountMinor: 0, currency: "ILS" },
    buyer: { name: "Test Buyer", email: "buyer@example.com" },
    locale: "en",
    returnUrl: "https://e.example/r",
    cancelUrl: "https://e.example/c",
    failUrl: "https://e.example/f",
    notifyUrl: "https://e.example/n",
    maxInstallments: 1,
    idemKey: "k",
    gatewayDocument: {
      documentType: "Receipt",
      name: "Test Buyer",
      email: "buyer@example.com",
      sendByEmail: true,
      vatFree: true,
      products: [{ description: "Moonrise", unitPriceMinor: 100, quantity: 1 }],
      externalId: "GG-7K3M9Q",
      language: "en",
    },
  };

  it("includes the gateway Document only in LIVE mode", () => {
    const cfg = {
      terminalNumber: 1000,
      apiName: "n",
      threeDSecure: "Enabled" as const,
    };
    expect(
      stripNulls(buildCreateRequest(input, { ...cfg, mode: "TEST" })),
    ).not.toHaveProperty("Document");
    expect(
      stripNulls(buildCreateRequest(input, { ...cfg, mode: "LIVE" })),
    ).toMatchObject({
      Document: {
        DocumentTypeToCreate: "Receipt",
        IsSendByEmail: true,
        IsVatFree: true,
        ExternalId: "GG-7K3M9Q",
        Products: [{ Description: "Moonrise", UnitCost: 1, Quantity: 1 }],
      },
    });
  });

  it("omits the document e-mail without consent", () => {
    const doc = buildCardcomDocument({
      ...(input.gatewayDocument as NonNullable<typeof input.gatewayDocument>),
      sendByEmail: false,
    });
    expect(doc).not.toHaveProperty("Email");
    expect(doc.IsSendByEmail).toBe(false);
  });

  it("names the product by artwork titles and order number only", () => {
    expect(
      cardcomProductName({
        lines: [{ name: "A" }, { name: "B" }],
        orderNumber: "GG-1",
        locale: "en",
      }),
    ).toBe("Original painting – A, B (GG-1)");
    const long = cardcomProductName({
      lines: [{ name: "x".repeat(400) }],
      orderNumber: "GG-1",
      locale: "he",
    });
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("(GG-1)")).toBe(true);
  });

  it("formats DDMMYYYY on the Israeli calendar day", () => {
    expect(cardcomDate(new Date("2026-09-30T21:30:00Z"))).toBe("01102026");
    expect(cardcomDate(new Date("2026-12-31T12:00:00Z"))).toBe("31122026");
  });
});

describe("notifications and listings", () => {
  it("event keys and body parsing", () => {
    expect(notificationEventKey(paid)).toBe("cc:lp-1:7654321:0");
    expect(
      notificationEventKey({ LowProfileId: "lp-2", ResponseCode: 5 }),
    ).toBe("cc:lp-2:none:5");
    expect(
      parseCardcomBody("LowProfileId=lp-3&ResponseCode=0&TranzactionId=42"),
    ).toEqual({
      LowProfileId: "lp-3",
      ResponseCode: 0,
      TranzactionId: 42,
    });
    expect(parseCardcomBody("{broken")).toEqual({});
  });

  it("parses ListTransactions charges, skipping refunds and failures", () => {
    expect(
      parseListTransactions({
        Tranzactions: [
          tx,
          { ...tx, TranzactionId: 2, IsRefund: true },
          { ...tx, TranzactionId: 3, DealType: "Refund" },
          { ...tx, TranzactionId: 4, ResponseCode: 4 },
          {
            ...tx,
            TranzactionId: 5,
            ReturnValue: ATTEMPT,
            LowProfileId: "lp-5",
          },
          { TranzactionId: "x" },
        ],
      }),
    ).toEqual([
      {
        transactionId: "7654321",
        amount: { amountMinor: 125_050, currency: "ILS" },
      },
      {
        transactionId: "5",
        amount: { amountMinor: 125_050, currency: "ILS" },
        returnValue: ATTEMPT,
        lowProfileId: "lp-5",
      },
    ]);
    expect(parseListTransactions(null)).toEqual([]);
  });
});
