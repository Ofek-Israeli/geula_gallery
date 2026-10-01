import "server-only";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import type { VatMode } from "@/lib/vat";
import type { Env } from "@/server/env";
import type { FetchLike } from "@/server/integrations/http";

/**
 * Tax-document provider contract (spec §4.3, frozen at `contracts-v1`). Each payment is documented
 * exactly once: the caller inserts `tax_documents(ISSUING, marker)` before calling, a timeout or
 * 5xx becomes UNKNOWN, and UNKNOWN is resolved with `findByMarker` before any retry.
 */
export type TaxDocumentProviderId = "mock" | "morning" | "gateway" | "none";

/** `TAX_DOCUMENTS_MODE` → `tax_documents.provider` (DB enum). */
export const TAXDOC_DB_PROVIDER = {
  mock: "MOCK",
  morning: "MORNING",
  gateway: "CARDCOM_GATEWAY",
  none: "MANUAL",
} as const satisfies Record<
  TaxDocumentProviderId,
  "MOCK" | "MORNING" | "CARDCOM_GATEWAY" | "MANUAL"
>;

export type TaxPaymentType =
  | "card"
  | "bit"
  | "apple_pay"
  | "google_pay"
  | "paypal"
  | "transfer"
  | "cash"
  | "cheque"
  | "other";

export interface IssueReceiptInput {
  /** `GG-7K3M9Q/RECEIPT/1`: Morning `description`, searched by `findByMarker`. */
  marker: string;
  orderNumber: string;
  vatMode: VatMode;
  zeroRatedExport: boolean;
  language: Locale;
  currency: Currency;
  client: {
    name: string;
    country: string;
    taxId?: string;
    companyName?: string;
    address?: string;
  };
  lines: { description: string; unitPriceMinor: number; quantity: 1 }[];
  payment: {
    type: TaxPaymentType;
    amountMinor: number;
    /** ISO date (Asia/Jerusalem calendar day). */
    date: string;
    reference: string;
    last4?: string;
    installments?: number;
  };
}

export interface IssueCreditNoteInput {
  marker: string;
  originalProviderDocId: string;
  amountMinor: number;
  currency: Currency;
  language: Locale;
  reason: string;
}

export interface IssuedDocument {
  providerDocId: string;
  /** Human document number (e.g. Morning serial, `DEMO-000123`). */
  docNumber: string;
  /** Provider type code (Morning 320/400/330, Cardcom document type). */
  docTypeCode: string;
  allocationNumber?: string;
  /** Provider-hosted view/download URL, when one exists. */
  url?: string;
  /** ISO timestamp. */
  issuedAt: string;
}

export interface TaxDocumentProvider {
  id: TaxDocumentProviderId;
  issueReceipt(i: IssueReceiptInput): Promise<IssuedDocument>;
  issueCreditNote(i: IssueCreditNoteInput): Promise<IssuedDocument>;
  findByMarker?(marker: string, around: Date): Promise<IssuedDocument | null>;
  getPdf?(providerDocId: string): Promise<Uint8Array>;
}

/**
 * The mode cannot document this payment automatically (gateway + PayPal/offline, gateway credit
 * notes, patur credit notes, `none`): the caller moves the row to NEEDS_MANUAL and alerts.
 */
export class TaxDocumentNeedsManualError extends Error {
  constructor(
    public readonly provider: TaxDocumentProviderId,
    public readonly reason: string,
  ) {
    super(`${provider}: needs a manual document (${reason})`);
    this.name = "TaxDocumentNeedsManualError";
  }
}

export interface TaxDocumentFactoryInput {
  env: Env;
  fetch?: FetchLike;
}
