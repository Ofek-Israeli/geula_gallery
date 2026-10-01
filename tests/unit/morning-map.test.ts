import { describe, expect, it } from "vitest";
import { buildGatewayDocument } from "@/server/taxdocs/gateway";
import {
  buildCreditNoteRequest,
  buildReceiptRequest,
  morningDocumentVatType,
  morningRowVatType,
} from "@/server/taxdocs/morning";
import type { IssueReceiptInput } from "@/server/taxdocs/types";

/** Spec §10.1 `morning-map` plus the Cardcom gateway document builder (spec §4.3). */
const receipt: IssueReceiptInput = {
  marker: "GG-7K3M9Q/RECEIPT/1",
  orderNumber: "GG-7K3M9Q",
  vatMode: "OSEK_PATUR",
  zeroRatedExport: false,
  language: "he",
  currency: "ILS",
  client: {
    name: "Test Buyer",
    country: "IL",
    companyName: "Buyer Ltd",
    taxId: "000000018",
  },
  lines: [{ description: "Moonrise", unitPriceMinor: 120_000, quantity: 1 }],
  payment: {
    type: "bit",
    amountMinor: 120_000,
    date: "2026-10-01",
    reference: "TX1",
  },
};

describe("morning builders", () => {
  it("receipt: type, marker, client and app payment row", () => {
    const body = buildReceiptRequest(receipt, {
      cancelUrl: "https://g.example/he/cancel",
    });
    expect(body).toMatchObject({
      type: 400,
      description: receipt.marker,
      signed: true,
      client: {
        name: "Buyer Ltd",
        taxId: "000000018",
        add: false,
        country: "IL",
      },
      payment: [{ type: 10, appType: 1, transactionId: "TX1", price: 1200 }],
    });
    expect(body.remarks).toBe(
      "הזמנה GG-7K3M9Q. ביטול עסקה: https://g.example/he/cancel",
    );
  });

  it("VAT types", () => {
    expect(morningDocumentVatType({ zeroRatedExport: true })).toBe(1);
    expect(morningDocumentVatType({ zeroRatedExport: false })).toBe(0);
    expect(
      morningRowVatType({ vatMode: "OSEK_MURSHE", zeroRatedExport: false }),
    ).toBe(1);
    expect(
      morningRowVatType({ vatMode: "OSEK_PATUR", zeroRatedExport: false }),
    ).toBe(0);
    expect(
      morningRowVatType({ vatMode: "OSEK_MURSHE", zeroRatedExport: true }),
    ).toBe(2);
  });

  it("credit note links the original and follows its VAT type", () => {
    const body = buildCreditNoteRequest(
      {
        marker: "GG-7K3M9Q/CREDIT_NOTE/1",
        originalProviderDocId: "doc-1",
        amountMinor: 5_000,
        currency: "ILS",
        language: "en",
        reason: "Partial refund",
      },
      { vatType: 1, clientName: null },
    );
    expect(body).toMatchObject({
      type: 330,
      vatType: 1,
      linkedDocumentIds: ["doc-1"],
      income: [{ price: 50, vatType: 2 }],
    });
    expect(body).not.toHaveProperty("client");
  });
});

describe("buildGatewayDocument", () => {
  it("patur → Receipt, VAT-free; e-mail only with consent", () => {
    expect(
      buildGatewayDocument({
        ...receipt,
        email: "buyer@example.com",
        sendByEmail: false,
      }),
    ).toEqual({
      documentType: "Receipt",
      name: "Buyer Ltd",
      sendByEmail: false,
      vatFree: true,
      taxId: "000000018",
      products: [
        { description: "Moonrise", unitPriceMinor: 120_000, quantity: 1 },
      ],
      externalId: "GG-7K3M9Q",
      language: "he",
    });
    expect(
      buildGatewayDocument({
        ...receipt,
        email: "buyer@example.com",
        sendByEmail: true,
      }).email,
    ).toBe("buyer@example.com");
  });

  it("murshe → TaxInvoiceAndReceipt, VAT-free only for exports", () => {
    const domestic = buildGatewayDocument({
      ...receipt,
      vatMode: "OSEK_MURSHE",
      sendByEmail: false,
    });
    expect(domestic.documentType).toBe("TaxInvoiceAndReceipt");
    expect(domestic.vatFree).toBe(false);
    expect(
      buildGatewayDocument({
        ...receipt,
        vatMode: "OSEK_MURSHE",
        zeroRatedExport: true,
        sendByEmail: false,
      }).vatFree,
    ).toBe(true);
  });
});
