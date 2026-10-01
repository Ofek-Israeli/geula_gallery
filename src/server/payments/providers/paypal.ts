import "server-only";
import type { PaymentProvider, ProviderFactoryInput } from "../types";
import { notConfigured } from "./stub";

/**
 * PayPal Orders v2, full-page redirect to the `payer-action` link (spec §4.2). M1 typed stub:
 * identity and capabilities read env; network methods throw `ProviderNotConfiguredError`. WS5
 * implements it with the generated Orders v2 / Payments v2 / Webhooks v1 types.
 */
export function createPaypalProvider({
  env,
}: ProviderFactoryInput): PaymentProvider {
  return {
    id: "paypal",
    mode: env.PAYPAL_MODE === "live" ? "LIVE" : "TEST",
    capabilities: {
      currencies: ["ILS", "USD"],
      wallets: [],
      installments: false,
      notificationAuth: "signature",
      requiresCapture: true,
      refunds: "api",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },
    merchantRef: () =>
      env.PAYPAL_MERCHANT_ID ?? notConfigured("paypal", "merchantRef"),
    authenticateNotification: async () =>
      notConfigured("paypal", "authenticateNotification"),
    parseNotification: () => notConfigured("paypal", "parseNotification"),
    createCheckout: async () => notConfigured("paypal", "createCheckout"),
    fetchPayment: async () => notConfigured("paypal", "fetchPayment"),
    capture: async () => notConfigured("paypal", "capture"),
    refund: async () => notConfigured("paypal", "refund"),
    getRefund: async () => notConfigured("paypal", "getRefund"),
  };
}
