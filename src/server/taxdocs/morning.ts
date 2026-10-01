import "server-only";
import { notConfigured } from "@/server/payments/providers/stub";
import type { TaxDocumentFactoryInput, TaxDocumentProvider } from "./types";

/**
 * Morning (Green Invoice) adapter (spec §4.3): OAuth2 client_credentials token cached until 60 s
 * before expiry; `POST /documents` (400 patur / 320 murshe / 330 credit note), marker in
 * `description`, `findByMarker` via `POST /documents/search`, PDF via download links. M1 typed stub;
 * WS5 implements it with `@/server/integrations/generated/morning`.
 */
export const MORNING_BASES = {
  production: {
    api: "https://api.greeninvoice.co.il/api/v1",
    auth: "https://api.morning.co",
  },
  sandbox: {
    api: "https://sandbox.d.greeninvoice.co.il/api/v1",
    auth: "https://api.sandbox.morning.dev",
  },
} as const;

export function createMorningTaxDocumentProvider(
  _input: TaxDocumentFactoryInput,
): TaxDocumentProvider {
  return {
    id: "morning",
    issueReceipt: async () => notConfigured("morning", "issueReceipt"),
    issueCreditNote: async () => notConfigured("morning", "issueCreditNote"),
    findByMarker: async () => notConfigured("morning", "findByMarker"),
    getPdf: async () => notConfigured("morning", "getPdf"),
  };
}
