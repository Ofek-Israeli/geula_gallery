import "server-only";
import type { Locale } from "@/lib/locale";
import type { Currency, Money } from "@/lib/money";
import type { PostalAddress } from "@/lib/validation/address";
import type { Env } from "@/server/env";
import type { FetchLike } from "@/server/integrations/http";

/**
 * Payment provider contract (spec §4.2, frozen at `contracts-v1`). Every adapter is a factory
 * `createXProvider({ env, fetch })`; tests inject a fixture-replaying `fetch`. `createCheckout`
 * always returns a full-page redirect: to the provider's hosted page (Cardcom, PayPal), or to our
 * own pay page whose card fields are the provider's hosted fields (Isracard/PayMe; see
 * `HostedFieldsProvider`). Card data never reaches our servers (PCI SAQ A).
 */
export type { Currency, Money, PostalAddress };

export type ProviderId = "mock" | "cardcom" | "paypal" | "isracard";
export const PROVIDER_IDS = [
  "mock",
  "cardcom",
  "paypal",
  "isracard",
] as const satisfies readonly ProviderId[];

/** DB enum value (`payment_provider`) for each adapter id. */
export const PROVIDER_DB_VALUE = {
  mock: "MOCK",
  cardcom: "CARDCOM",
  paypal: "PAYPAL",
  isracard: "ISRACARD",
} as const satisfies Record<
  ProviderId,
  "MOCK" | "CARDCOM" | "PAYPAL" | "ISRACARD"
>;

export type ProviderMode = "MOCK" | "TEST" | "LIVE";

export type VerifiedState =
  | "pending"
  | "requires_capture"
  | "review"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "refunded"
  | "partially_refunded";

export type Wallet = "bit" | "apple_pay" | "google_pay";

export interface PaymentCapabilities {
  currencies: Currency[];
  wallets: Wallet[];
  installments: boolean;
  notificationAuth: "signature" | "unsigned-requery" | "none";
  requiresCapture: boolean;
  refunds: "api" | "manual";
  partialRefunds: boolean;
  issuesTaxDocuments: boolean;
}

/** Cardcom gateway-mode document (spec §4.3 `gateway`); built by `taxdocs/gateway.ts`. */
export interface GatewayDocumentSpec {
  documentType: "Receipt" | "TaxInvoiceAndReceipt";
  name: string;
  /** Only with receipt-by-email consent. */
  email?: string;
  sendByEmail: boolean;
  vatFree: boolean;
  taxId?: string;
  products: { description: string; unitPriceMinor: number; quantity: 1 }[];
  /** The order number. */
  externalId: string;
  language: Locale;
}

export interface CreateCheckoutInput {
  attemptId: string;
  attemptSeq: number;
  orderId: string;
  orderNumber: string;
  amount: Money;
  lines: { name: string; amount: Money }[];
  shipping: Money;
  insurance: Money;
  /** null ⇒ never send PII (the shared Cardcom test terminal). */
  buyer: { name: string; email: string; phone?: string } | null;
  shipTo?: PostalAddress;
  locale: Locale;
  returnUrl: string;
  cancelUrl: string;
  failUrl: string;
  notifyUrl: string;
  maxInstallments: number;
  idemKey: string;
  gatewayDocument?: GatewayDocumentSpec;
}

export interface VerifiedPayment {
  state: VerifiedState;
  /**
   * The provider's id of the payment when the lookup was by our reference (Isracard: the PayMe
   * sale id); finalize adopts it for an attempt whose `provider_ref` is still a placeholder.
   */
  providerRef?: string;
  amount: Money | null;
  /** What the provider echoes back as our reference (Cardcom ReturnValue / PayPal custom_id). */
  echoedReference: string | null;
  /** Terminal number / payee merchant id, compared with `payment_attempts.merchant_ref`. */
  merchantRef: string | null;
  transactionId?: string;
  captureId?: string;
  method?: string;
  installments?: number;
  last4?: string;
  brand?: string;
  isForeignCard?: boolean;
  approvalCode?: string;
  refundedMinor?: number;
  gatewayDocument?: { type: string; number: string; url?: string };
  rawRedacted: unknown;
}

export interface IncomingNotification {
  headers: Headers;
  rawBody: string;
  query: URLSearchParams;
}

export interface ParsedNotification {
  /** Dedupe key for `payment_events (provider, event_key)`. */
  eventKey: string;
  eventType?: string;
  attemptId?: string;
  providerRef?: string;
  refundCustomId?: string;
  payloadRedacted: unknown;
}

export interface RefundInput {
  refundId: string;
  /** The attempt's `provider_ref` (Isracard refunds by PayMe sale id). */
  providerRef?: string;
  transactionId: string;
  captureId?: string;
  amount: Money;
  isFull: boolean;
  idemKey: string;
  /** Count of earlier refund rows on this attempt (Cardcom `AllowMultipleRefunds`). */
  priorRefunds: number;
  /** `<orderNumber>-R<n>` (PayPal invoice_id). */
  invoiceRef: string;
  reason: string;
}

export interface RefundResult {
  status: "succeeded" | "pending" | "manual_required";
  providerRefundId?: string;
  rawRedacted: unknown;
}

export interface RefundStatusResult {
  status: "succeeded" | "pending" | "failed" | "not_found";
  providerRefundId?: string;
}

export interface ListedTransaction {
  transactionId: string;
  amount: Money;
  returnValue?: string;
  lowProfileId?: string;
}

export interface PaymentProvider {
  id: ProviderId;
  mode: ProviderMode;
  capabilities: PaymentCapabilities;
  merchantRef(): string;
  /** Cheap, no DB. */
  authenticateNotification(
    n: IncomingNotification & { ip: string },
  ): Promise<boolean>;
  /** A hint only: finalization always re-queries the provider. */
  parseNotification(n: IncomingNotification): ParsedNotification;
  createCheckout(
    i: CreateCheckoutInput,
  ): Promise<{ providerRef: string; next: { kind: "redirect"; url: string } }>;
  /** Authoritative. */
  fetchPayment(r: {
    providerRef: string;
    attemptId: string;
  }): Promise<VerifiedPayment>;
  capture?(r: {
    providerRef: string;
    idemKey: string;
  }): Promise<VerifiedPayment>;
  refund(i: RefundInput): Promise<RefundResult>;
  getRefund?(r: {
    providerRefundId?: string;
    refundId: string;
    captureId?: string;
  }): Promise<RefundStatusResult>;
  listTransactions?(r: { from: Date; to: Date }): Promise<ListedTransaction[]>;
}

/** The sale a hosted-fields provider creates before the card is charged (Isracard `generate-sale`). */
export interface CreateSaleInput {
  attemptId: string;
  amount: Money;
  /** Shown to the buyer and on the provider's documents (titles only, no PII). */
  productName: string;
  installments: number;
  locale: Locale;
  /** Our webhook URL (with the attempt's HMAC token). */
  notifyUrl: string;
  /** Our return route: where a 3-D Secure challenge sends the buyer back. */
  returnUrl: string;
  /** Our pay page: where a failed 3-D Secure authentication sends the buyer back. */
  cancelUrl: string;
}

export interface PaySaleInput extends CreateSaleInput {
  /** The provider's sale id from `createSale`. */
  saleId: string;
  /** The one-time card token the pay page got from the hosted fields. */
  buyerKey: string;
  /** The hosted fields' client data (3-D Secure device data), passed through as is. */
  clientData: string | null;
  /** Live mode only (never sent to a test environment); the card holder typed the rest. */
  buyer: { name: string; email: string } | null;
  /** Israeli ID number typed by the card holder, when the pay page asked for it. */
  socialId: string | null;
}

/**
 * - `completed`: the provider reports the sale paid (still verified by `fetchPayment`);
 * - `challenge`: 3-D Secure needs the buyer: send the top window to `redirectUrl`;
 * - `declined`: a clear refusal; nothing was charged.
 * A timeout or an unreadable answer throws (`outcomeUnknown`): the payment is then settled only
 * by `fetchPayment` (callback, reconcile, sweep), never by charging again.
 */
export type PaySaleResult =
  | { kind: "completed" }
  | { kind: "challenge"; redirectUrl: string }
  | { kind: "declined"; code: string; message: string };

/**
 * A provider whose card fields are its hosted fields on our own pay page (PCI SAQ A, iframe):
 * `createCheckout` returns our pay page, the page tokenizes the card in the provider's iframes, and
 * the server creates the sale and pays it once with the one-time token (`charge.ts`).
 */
export interface HostedFieldsProvider extends PaymentProvider {
  hostedFields: {
    /** What the pay page passes to the provider's script (`PayMe.create`). */
    client(): { apiKey: string; testMode: boolean; scriptUrl: string };
    createSale(i: CreateSaleInput): Promise<{ saleId: string }>;
    paySale(i: PaySaleInput): Promise<PaySaleResult>;
  };
}

export function isHostedFieldsProvider(
  p: PaymentProvider,
): p is HostedFieldsProvider {
  return "hostedFields" in p;
}

/** Inputs of every adapter factory. `env` is passed in so tests can build adapters freely. */
export interface ProviderFactoryInput {
  env: Env;
  fetch?: FetchLike;
}

export type ProviderFactory = (input: ProviderFactoryInput) => PaymentProvider;
