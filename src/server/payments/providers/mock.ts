import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { PaymentProvider, ProviderFactoryInput } from "../types";

/**
 * The mock provider (spec §4.2 `mock`): hosted page `/[locale]/mock-pay/[ref]`, HMAC-signed
 * webhooks (`x-mock-signature: t=<unix>,v1=<hex>` over `t + "." + rawBody`, 300 s tolerance),
 * DIRECT and CAPTURE flows, idempotent capture/refund per request id. M1 stub with the real
 * identity and capabilities; the M2 commerce lead implements the methods.
 */
export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
export const MOCK_SIGNATURE_TOLERANCE_SEC = 300;
export const MOCK_MERCHANT_REF = "mock-merchant";

export function createMockProvider(
  _input: ProviderFactoryInput,
): PaymentProvider {
  const todo = (what: string) => notImplemented(`mock.${what}`, "M2");
  return {
    id: "mock",
    mode: "MOCK",
    capabilities: {
      currencies: ["ILS", "USD"],
      wallets: [],
      installments: false,
      notificationAuth: "signature",
      requiresCapture: false,
      refunds: "api",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },
    merchantRef: () => MOCK_MERCHANT_REF,
    authenticateNotification: async () => todo("authenticateNotification"),
    parseNotification: () => todo("parseNotification"),
    createCheckout: async () => todo("createCheckout"),
    fetchPayment: async () => todo("fetchPayment"),
    capture: async () => todo("capture"),
    refund: async () => todo("refund"),
    getRefund: async () => todo("getRefund"),
  };
}
