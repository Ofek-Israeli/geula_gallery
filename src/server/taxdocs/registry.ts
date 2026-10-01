import "server-only";
import { env as defaultEnv, type Env } from "@/server/env";
import type { FetchLike } from "@/server/integrations/http";
import { createGatewayTaxDocumentProvider } from "./gateway";
import { createMockTaxDocumentProvider } from "./mock";
import { createMorningTaxDocumentProvider } from "./morning";
import { createNoneTaxDocumentProvider } from "./none";
import type { TaxDocumentProvider, TaxDocumentProviderId } from "./types";

/** The adapter for `TAX_DOCUMENTS_MODE` (spec §4.3 "Modes"). WS2 owns this file. */
export function taxDocumentProvider(
  deps: { env?: Env; fetch?: FetchLike; mode?: TaxDocumentProviderId } = {},
): TaxDocumentProvider {
  const e = deps.env ?? defaultEnv;
  const mode = deps.mode ?? e.TAX_DOCUMENTS_MODE;
  const input = { env: e, fetch: deps.fetch };
  switch (mode) {
    case "mock":
      return createMockTaxDocumentProvider(input);
    case "morning":
      return createMorningTaxDocumentProvider(input);
    case "gateway":
      return createGatewayTaxDocumentProvider(input);
    case "none":
      return createNoneTaxDocumentProvider();
  }
}
