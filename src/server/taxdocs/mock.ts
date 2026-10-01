import "server-only";
import {
  ProviderRejectedError,
  ProviderTimeoutError,
} from "@/server/integrations/http";
import type {
  IssueCreditNoteInput,
  IssuedDocument,
  IssueReceiptInput,
  TaxDocumentFactoryInput,
  TaxDocumentProvider,
} from "./types";

/**
 * Mock tax documents (spec §4.3 `mock`). Nothing is sent anywhere: a "document" is derived from its
 * marker, so issuing the same marker twice yields the same document (idempotent per marker, the way
 * a Morning document is found again by its `description`). The buyer view is the HTML page
 * `/[locale]/print/receipt/<docNumber>?k=`, stamped "DEMO – not a tax document /
 * הדגמה – אינו מסמך חשבונאי".
 *
 * Numbers are `DEMO-<order suffix>-R<n>` (receipts) and `DEMO-<order suffix>-C<n>` (credit notes).
 * Deviation from the spec's `DEMO-000123` example: deriving the number from the marker keeps it
 * unique and stable across retries without a counter table.
 *
 * `findByMarker` answers from this process's memory. A document issued before a restart counts as
 * "confirmed absent" and is issued again, which is harmless because issuing is idempotent.
 *
 * Tests steer failures through `mockTaxDocHooks` (one-shot flags, never consulted in production).
 */
export const MOCK_DOC_PREFIX = "DEMO-";

export interface MockTaxDocHooks {
  /** The next issue call times out; `applied` = the document was issued before the "timeout". */
  issueTimeout: null | { applied: boolean };
  /** The next issue call is rejected (a clear 4xx). */
  issueReject: boolean;
  /** The next N `findByMarker` calls are inconclusive (they time out). */
  searchInconclusive: number;
  calls: { issue: number; search: number };
}

function freshHooks(): MockTaxDocHooks {
  return {
    issueTimeout: null,
    issueReject: false,
    searchInconclusive: 0,
    calls: { issue: 0, search: 0 },
  };
}

export const mockTaxDocHooks: MockTaxDocHooks = freshHooks();

/** Documents "issued" by this process, by marker (the mock's provider-side state). */
const issued = new Map<string, IssuedDocument>();

export function resetMockTaxDocHooks(opts: { forget?: boolean } = {}): void {
  Object.assign(mockTaxDocHooks, freshHooks());
  if (opts.forget) issued.clear();
}

/** `GG-7K3M9Q/RECEIPT/1` → `DEMO-7K3M9Q-R1`; `GG-7K3M9Q/CREDIT_NOTE/2` → `DEMO-7K3M9Q-C2`. */
export function mockDocNumber(marker: string): string {
  const [order = "", kind = "", n = "1"] = marker.split("/");
  const suffix = order.replace(/^GG-/, "");
  const letter = kind === "CREDIT_NOTE" ? "C" : "R";
  return `${MOCK_DOC_PREFIX}${suffix}-${letter}${n}`;
}

export function isMockDocNumber(docNumber: string): boolean {
  return /^DEMO-[0-9A-Z]{6}-[RC]\d+$/.test(docNumber);
}

function documentFor(marker: string, typeCode: string): IssuedDocument {
  return {
    providerDocId: `mock-doc:${marker}`,
    docNumber: mockDocNumber(marker),
    docTypeCode: typeCode,
    issuedAt: new Date().toISOString(),
  };
}

function issue(
  hooksOn: boolean,
  marker: string,
  typeCode: string,
): IssuedDocument {
  if (hooksOn) {
    mockTaxDocHooks.calls.issue += 1;
    if (mockTaxDocHooks.issueReject) {
      mockTaxDocHooks.issueReject = false;
      throw new ProviderRejectedError("mock", "mock: document rejected", 422);
    }
    const timeout = mockTaxDocHooks.issueTimeout;
    if (timeout) {
      mockTaxDocHooks.issueTimeout = null;
      if (timeout.applied && !issued.has(marker)) {
        issued.set(marker, documentFor(marker, typeCode));
      }
      throw new ProviderTimeoutError("mock");
    }
  }
  const existing = issued.get(marker);
  if (existing) return existing;
  const doc = documentFor(marker, typeCode);
  issued.set(marker, doc);
  return doc;
}

export function createMockTaxDocumentProvider(
  input: TaxDocumentFactoryInput,
): TaxDocumentProvider {
  const hooksOn = !input.env.isProduction;
  return {
    id: "mock",
    // Morning's type codes, so the admin sees what a real document would be: 400 receipt (patur),
    // 320 tax invoice-receipt (murshe), 330 credit note.
    issueReceipt: async (i: IssueReceiptInput) =>
      issue(hooksOn, i.marker, i.vatMode === "OSEK_PATUR" ? "400" : "320"),
    issueCreditNote: async (i: IssueCreditNoteInput) =>
      issue(hooksOn, i.marker, "330"),
    findByMarker: async (marker: string) => {
      if (hooksOn) {
        mockTaxDocHooks.calls.search += 1;
        if (mockTaxDocHooks.searchInconclusive > 0) {
          mockTaxDocHooks.searchInconclusive -= 1;
          throw new ProviderTimeoutError("mock", "mock: search timed out");
        }
      }
      return issued.get(marker) ?? null;
    },
  };
}
