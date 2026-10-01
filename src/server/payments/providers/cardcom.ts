import "server-only";
import type { PaymentProvider, ProviderFactoryInput, Wallet } from "../types";
import { notConfigured } from "./stub";

/**
 * Cardcom LowProfile v11 (spec §4.2). M1 typed stub: identity and capabilities are real (they only
 * read env), every network method throws `ProviderNotConfiguredError`. WS5 implements it with
 * `createTypedClient<paths>` from `@/server/integrations/generated/cardcom`.
 */
const WALLET_FROM_ENV = {
  bit: "bit",
  applepay: "apple_pay",
  googlepay: "google_pay",
} as const satisfies Record<string, Wallet>;

export function createCardcomProvider({
  env,
}: ProviderFactoryInput): PaymentProvider {
  const mode = env.CARDCOM_MODE === "live" ? "LIVE" : "TEST";
  return {
    id: "cardcom",
    mode,
    capabilities: {
      currencies: [...env.CARDCOM_CURRENCIES],
      wallets: env.CARDCOM_WALLETS.map((w) => WALLET_FROM_ENV[w]),
      installments: true,
      notificationAuth: "unsigned-requery",
      requiresCapture: false,
      refunds: env.CARDCOM_API_PASSWORD ? "api" : "manual",
      partialRefunds: true,
      issuesTaxDocuments: env.TAX_DOCUMENTS_MODE === "gateway",
    },
    merchantRef: () =>
      env.CARDCOM_TERMINAL_NUMBER ?? notConfigured("cardcom", "merchantRef"),
    authenticateNotification: async () =>
      notConfigured("cardcom", "authenticateNotification"),
    parseNotification: () => notConfigured("cardcom", "parseNotification"),
    createCheckout: async () => notConfigured("cardcom", "createCheckout"),
    fetchPayment: async () => notConfigured("cardcom", "fetchPayment"),
    refund: async () => notConfigured("cardcom", "refund"),
    listTransactions: async () => notConfigured("cardcom", "listTransactions"),
  };
}
