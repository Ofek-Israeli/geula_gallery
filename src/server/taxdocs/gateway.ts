import "server-only";
import { notConfigured } from "@/server/payments/providers/stub";
import type { GatewayDocumentSpec } from "@/server/payments/types";
import {
  type IssueReceiptInput,
  type TaxDocumentFactoryInput,
  TaxDocumentNeedsManualError,
  type TaxDocumentProvider,
} from "./types";

/**
 * Cardcom gateway mode (spec §4.3 `gateway`): Cardcom issues the document with the charge, from the
 * `Document` block of `LowProfile/Create`. The receipt job copies `gatewayDocument` from the
 * verified payment; PayPal, offline payments and credit notes become NEEDS_MANUAL. Env refuses
 * gateway with `CARDCOM_MODE=test`. M1 typed stub; WS5 implements `buildGatewayDocument`.
 */
export function buildGatewayDocument(
  _input: IssueReceiptInput & { email?: string; sendByEmail: boolean },
): GatewayDocumentSpec {
  return notConfigured("gateway", "buildGatewayDocument");
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
