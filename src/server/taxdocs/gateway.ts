import "server-only";
import type { GatewayDocumentSpec } from "@/server/payments/types";
import {
  type IssueReceiptInput,
  type TaxDocumentFactoryInput,
  TaxDocumentNeedsManualError,
  type TaxDocumentProvider,
} from "./types";

/**
 * Cardcom gateway mode (spec §4.3 `gateway`): Cardcom issues the document with the charge, from the
 * `Document` block of `LowProfile/Create` (`cardcom-map.ts#buildCardcomDocument`). The receipt job
 * copies `gatewayDocument` from the verified payment; PayPal, offline payments and credit notes
 * become NEEDS_MANUAL. Env refuses gateway with `CARDCOM_MODE=test`.
 *
 * `buildGatewayDocument`: `Receipt` for an osek patur, `TaxInvoiceAndReceipt` otherwise; VAT-free
 * for patur or zero-rated exports; the e-mail only with receipt-by-email consent; the order number
 * as `ExternalId`.
 */
export function buildGatewayDocument(
  input: IssueReceiptInput & { email?: string; sendByEmail: boolean },
): GatewayDocumentSpec {
  const patur = input.vatMode === "OSEK_PATUR";
  const sendByEmail = input.sendByEmail && !!input.email;
  return {
    documentType: patur ? "Receipt" : "TaxInvoiceAndReceipt",
    name: input.client.companyName ?? input.client.name,
    ...(sendByEmail && input.email ? { email: input.email } : {}),
    sendByEmail,
    vatFree: patur || input.zeroRatedExport,
    ...(input.client.taxId ? { taxId: input.client.taxId } : {}),
    products: input.lines.map((l) => ({
      description: l.description,
      unitPriceMinor: l.unitPriceMinor,
      quantity: 1 as const,
    })),
    externalId: input.orderNumber,
    language: input.language,
  };
}

export function createGatewayTaxDocumentProvider(
  _input: TaxDocumentFactoryInput,
): TaxDocumentProvider {
  return {
    id: "gateway",
    // Gateway documents are created with the charge; a standalone receipt is never possible.
    issueReceipt: async () => {
      throw new TaxDocumentNeedsManualError(
        "gateway",
        "standalone receipts are not supported in gateway mode",
      );
    },
    issueCreditNote: async () => {
      throw new TaxDocumentNeedsManualError(
        "gateway",
        "credit notes are not supported in gateway mode",
      );
    },
  };
}
