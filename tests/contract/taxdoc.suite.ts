/**
 * Shared tax-document provider contract (spec §10.2: mock, morning). Every provider must issue
 * receipts with the Morning type codes (400 patur / 320 murshe) and credit notes (330), return a
 * complete `IssuedDocument`, and answer `findByMarker` with the issued document or null.
 */
import { describe, expect, it } from "vitest";
import type {
  IssueCreditNoteInput,
  IssueReceiptInput,
  TaxDocumentProvider,
} from "@/server/taxdocs/types";
import type { ReplayRoute } from "./support/replay";

export type TaxDocStep =
  | "receipt-patur"
  | "receipt-murshe"
  | "find-hit"
  | "find-miss"
  | "credit-note";

export interface TaxDocHarness {
  name: string;
  build(step: TaxDocStep): Promise<TaxDocumentProvider>;
  /** The marker the provider's "find-hit" data knows about. */
  knownMarker: string;
}

export function receiptInput(
  overrides: Partial<IssueReceiptInput> = {},
): IssueReceiptInput {
  return {
    marker: "GG-7K3M9Q/RECEIPT/1",
    orderNumber: "GG-7K3M9Q",
    vatMode: "OSEK_PATUR",
    zeroRatedExport: false,
    language: "he",
    currency: "ILS",
    client: { name: "Test Buyer", country: "IL" },
    lines: [
      { description: "Moonrise", unitPriceMinor: 120_000, quantity: 1 },
      { description: "משלוח", unitPriceMinor: 5_050, quantity: 1 },
    ],
    payment: {
      type: "card",
      amountMinor: 125_050,
      date: "2026-10-01",
      reference: "7654321",
      last4: "4580",
      installments: 1,
    },
    ...overrides,
  };
}

export function creditNoteInput(
  overrides: Partial<IssueCreditNoteInput> = {},
): IssueCreditNoteInput {
  return {
    marker: "GG-7K3M9Q/CREDIT_NOTE/1",
    originalProviderDocId: "6f0c8a2e-1111-4a5b-9c0d-000000000001",
    amountMinor: 125_050,
    currency: "ILS",
    language: "he",
    reason: "Cancellation of order GG-7K3M9Q",
    ...overrides,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function taxDocContract(h: TaxDocHarness): void {
  describe(`tax document contract: ${h.name}`, () => {
    it("issues a patur receipt (400) with a complete IssuedDocument", async () => {
      const provider = await h.build("receipt-patur");
      const doc = await provider.issueReceipt(receiptInput());
      expect(doc.providerDocId).toMatch(/\S/);
      expect(doc.docNumber).toMatch(/\S/);
      expect(doc.docTypeCode).toBe("400");
      expect(doc.issuedAt).toMatch(ISO);
    });

    it("issues a murshe tax invoice-receipt (320)", async () => {
      const provider = await h.build("receipt-murshe");
      const doc = await provider.issueReceipt(
        receiptInput({
          vatMode: "OSEK_MURSHE",
          marker: "GG-7K3M9Q/INVOICE_RECEIPT/1",
        }),
      );
      expect(doc.docTypeCode).toBe("320");
    });

    it("finds an issued document by its marker and answers null otherwise", async () => {
      const hit = await h.build("find-hit");
      const found = await hit.findByMarker?.(
        h.knownMarker,
        new Date("2026-10-01T12:00:00Z"),
      );
      expect(found?.providerDocId).toMatch(/\S/);
      expect(found?.issuedAt).toMatch(ISO);
      const miss = await h.build("find-miss");
      expect(
        await miss.findByMarker?.(
          "GG-NOPE00/RECEIPT/1",
          new Date("2026-10-01T12:00:00Z"),
        ),
      ).toBeNull();
    });

    it("issues a credit note (330) for a murshe receipt", async () => {
      const provider = await h.build("credit-note");
      const doc = await provider.issueCreditNote(creditNoteInput());
      expect(doc.docTypeCode).toBe("330");
      expect(doc.providerDocId).toMatch(/\S/);
    });
  });
}

export type { ReplayRoute };
