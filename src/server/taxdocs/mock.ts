import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { TaxDocumentFactoryInput, TaxDocumentProvider } from "./types";

/**
 * Mock tax documents (spec §4.3 `mock`): numbers `DEMO-000123`, HTML view at
 * `/[locale]/print/receipt/[number]?k=` stamped "DEMO – not a tax document". M1 stub; M2 implements.
 */
export const MOCK_DOC_PREFIX = "DEMO-";

export function createMockTaxDocumentProvider(
  _input: TaxDocumentFactoryInput,
): TaxDocumentProvider {
  return {
    id: "mock",
    issueReceipt: async () => notImplemented("mock taxdocs issueReceipt", "M2"),
    issueCreditNote: async () =>
      notImplemented("mock taxdocs issueCreditNote", "M2"),
    findByMarker: async () => notImplemented("mock taxdocs findByMarker", "M2"),
  };
}
