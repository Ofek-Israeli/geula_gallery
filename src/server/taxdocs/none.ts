import "server-only";
import { TaxDocumentNeedsManualError, type TaxDocumentProvider } from "./types";

/** `TAX_DOCUMENTS_MODE=none` (DEMO_MODE only): every document becomes NEEDS_MANUAL. */
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
