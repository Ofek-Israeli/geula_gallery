import "server-only";
import { TaxDocumentNeedsManualError, type TaxDocumentProvider } from "./types";

/**
 * `TAX_DOCUMENTS_MODE=none`: receipts are issued by hand (the painter's choice, 2026-10-25), and a
 * showcase without sales. Every document becomes NEEDS_MANUAL: an admin alert until the painter
 * records the receipt she issued (`recordManualTaxDocument`). Nothing is emailed to the buyer.
 */
export function createNoneTaxDocumentProvider(): TaxDocumentProvider {
  return {
    id: "none",
    issueReceipt: async () => {
      throw new TaxDocumentNeedsManualError("none", "TAX_DOCUMENTS_MODE=none");
    },
    issueCreditNote: async () => {
      throw new TaxDocumentNeedsManualError("none", "TAX_DOCUMENTS_MODE=none");
    },
  };
}
