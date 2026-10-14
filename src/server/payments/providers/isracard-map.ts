import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Currency } from "@/lib/money";
import type {
  CreateSaleInput,
  ListedTransaction,
  PaySaleInput,
  PaySaleResult,
  VerifiedPayment,
  VerifiedState,
} from "../types";

/**
 * Pure request/response mapping for Isracard's e-commerce service, which runs on PayMe
 * (docs.payme.io, "Payments – API Reference" and "Guides", read 2026-10-14):
 *
 * - hosts: `https://sandbox.payme.io/api` (staging) and `https://live.payme.io/api`;
 * - hosted fields: `https://cdn.payme.io/hf/v1/hostedfields.js`, frames from `https://hf.payme.io`;
 * - 3-D Secure with hosted fields ("3DS Integration Using JS API"): `generate-sale` creates the
 *   sale (`payme_sale_id`), then `pay-sale` pays it with the one-time `buyer_key` and the
 *   `meta_data_jwt` client data; the answer is `status_code` 0 (completed), 5 with `redirect_url`
 *   (challenge) or 1 (failed);
 * - verification: `get-transactions` filtered by our `transaction_id` (the attempt id), each row
 *   carrying `sale_status`, `transaction_error_code` (20000 = success), price and currency;
 * - callbacks: form-encoded POSTs (`notify_type`, `payme_sale_id`, `transaction_id`, `sale_status`…);
 *   only a hint here, the URL's HMAC token binds them to the attempt;
 * - `refund-sale` needs the partner key `payme_client_key`.
 *
 * Amounts are integer minor units (agorot / cents) both ways; the minimum sale is 500.
 */
export const PAYME_API_BASE = {
  TEST: "https://sandbox.payme.io/api",
  LIVE: "https://live.payme.io/api",
} as const;
export const PAYME_HOSTED_FIELDS_SCRIPT =
  "https://cdn.payme.io/hf/v1/hostedfields.js";

/** `provider_ref` of an Isracard attempt whose sale has not been created yet (the pay page). */
export const PENDING_SALE_PREFIX = "hf:";

export function pendingSaleRef(attemptId: string): string {
  return `${PENDING_SALE_PREFIX}${attemptId}`;
}

export function isPendingSaleRef(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(PENDING_SALE_PREFIX);
}

/**
 * `payment_attempts.merchant_ref` for Isracard: a fingerprint of the seller id. PayMe calls the
 * `seller_payme_id` a private key, so it is never stored or logged; equal fingerprints still prove
 * a payment was made on the same account.
 */
export function sellerFingerprint(sellerId: string): string {
  return `mpl:${createHash("sha256").update(sellerId).digest("hex").slice(0, 16)}`;
}

const statusCode = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().nullish(),
);
const text = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z.string().nullish(),
);
const amount = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().nullish(),
);

// ---------------------------------------------------------------- generate-sale

export function buildGenerateSale(
  i: CreateSaleInput,
  sellerId: string,
  mode: "TEST" | "LIVE",
): Record<string, unknown> {
  const name = mode === "TEST" ? `TEST – ${i.productName}` : i.productName;
  return {
    seller_payme_id: sellerId,
    sale_price: i.amount.amountMinor,
    currency: i.amount.currency,
    product_name: name.slice(0, 500),
    transaction_id: i.attemptId,
    installments: String(Math.max(1, Math.floor(i.installments))),
    sale_type: "sale",
    sale_payment_method: "credit-card",
    sale_callback_url: i.notifyUrl,
    sale_return_url: i.returnUrl,
    // A failed 3-D Secure authentication returns the buyer to our pay page, not PayMe's.
    cancel_url: i.cancelUrl,
    sale_send_notification: false,
    language: i.locale,
  };
}

export const generateSaleResponseSchema = z.looseObject({
  status_code: statusCode,
  payme_sale_id: text,
  status_error_code: text,
  status_error_details: text,
});

// ---------------------------------------------------------------- pay-sale

export function buildPaySale(
  i: PaySaleInput,
  sellerId: string,
): Record<string, unknown> {
  return {
    seller_payme_id: sellerId,
    payme_sale_id: i.saleId,
    sale_price: String(i.amount.amountMinor),
    currency: i.amount.currency,
    installments: String(Math.max(1, Math.floor(i.installments))),
    language: i.locale,
    sale_callback_url: i.notifyUrl,
    sale_return_url: i.returnUrl,
    capture_buyer: 0,
    buyer_key: i.buyerKey,
    ...(i.clientData ? { meta_data_jwt: i.clientData } : {}),
    ...(i.buyer
      ? { buyer_name: i.buyer.name, buyer_email: i.buyer.email }
      : {}),
    ...(i.socialId ? { buyer_social_id: i.socialId } : {}),
  };
}

export const paySaleResponseSchema = z.looseObject({
  status_code: statusCode,
  sale_status: text,
  redirect_url: text,
  status_error_code: text,
  status_error_details: text,
});

/** `pay-sale`'s answer (the "3DS Integration Using JS API" response handling). */
export function mapPaySale(
  d: z.infer<typeof paySaleResponseSchema>,
): PaySaleResult | null {
  if (d.status_code === 5 && d.redirect_url) {
    return { kind: "challenge", redirectUrl: d.redirect_url };
  }
  const status = (d.sale_status ?? "").toLowerCase();
  if (
    d.status_code === 1 ||
    status === "failed" ||
    status === "failure" ||
    status === "canceled"
  ) {
    return {
      kind: "declined",
      code: d.status_error_code ?? (status || "1"),
      message: (d.status_error_details ?? "").slice(0, 200),
    };
  }
  if (d.status_code === 0) return { kind: "completed" };
  return null;
}

// ---------------------------------------------------------------- get-transactions

const transactionSchema = z.looseObject({
  seller_payme_id: text,
  sale_payme_id: text,
  transaction_id: text,
  payme_transaction_id: text,
  sale_status: text,
  transaction_status: text,
  transaction_type: amount,
  transaction_action: text,
  transaction_price: amount,
  sale_price: amount,
  sale_currency: text,
  sale_installments: amount,
  sale_auth_number: text,
  transaction_error_code: amount,
  transaction_created_at: text,
  sale_is_3ds: z.unknown().optional(),
  sale_buyer_details: z
    .looseObject({
      buyer_card_mask: text,
      buyer_card_brand: text,
      buyer_card_is_foreign: z.unknown().optional(),
    })
    .nullish(),
});
export type PaymeTransaction = z.infer<typeof transactionSchema>;

export const transactionsResponseSchema = z.looseObject({
  status_code: statusCode,
  items: z.array(z.unknown()).nullish(),
  status_error_code: text,
  status_error_details: text,
});

/** Rows that parse; anything else in the list is ignored (never trusted). */
export function parseTransactions(items: unknown[] | null | undefined) {
  const out: PaymeTransaction[] = [];
  for (const item of items ?? []) {
    const parsed = transactionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const SUCCESS_ERROR_CODE = 20000;
const CHARGE_ACTIONS = new Set(["debit", "capture"]);
const REFUND_ACTIONS = new Set(["refund", "partialrefund"]);

function isCharge(t: PaymeTransaction): boolean {
  const action = (t.transaction_action ?? "").toLowerCase();
  return CHARGE_ACTIONS.has(action) || (!action && t.transaction_type === 1);
}

function isRefund(t: PaymeTransaction): boolean {
  return REFUND_ACTIONS.has((t.transaction_action ?? "").toLowerCase());
}

function currencyOf(v: string | null | undefined): Currency | null {
  const c = (v ?? "").toUpperCase();
  return c === "ILS" || c === "USD" ? c : null;
}

const SALE_STATE: Record<string, VerifiedState> = {
  initial: "pending",
  completed: "succeeded",
  refunded: "refunded",
  "partial-refund": "partially_refunded",
  // We never ask for an authorization (J5): one seen needs a person, never a capture call.
  authorized: "review",
  failed: "failed",
  failure: "failed",
  canceled: "canceled",
  cancelled: "canceled",
  voided: "canceled",
  "partial-void": "review",
  chargeback: "refunded",
  "partial-chargeback": "partially_refunded",
};

/**
 * The authoritative state of one attempt's sale. Rows belong to the attempt when they carry our
 * `transaction_id` (the attempt id) or the PayMe sale id stored for it; the echoed reference is
 * the attempt id only in that case. A "completed" sale counts as paid only with a charge row whose
 * `transaction_error_code` is 20000; anything unclear stays `pending` (reconciled later). The query
 * is filtered by our seller id, so a row without `seller_payme_id` belongs to `sellerId`.
 */
export function mapTransactions(
  rows: PaymeTransaction[],
  ref: { attemptId: string; saleId: string | null; sellerId: string },
): VerifiedPayment {
  const mine = rows.filter(
    (t) =>
      t.transaction_id === ref.attemptId ||
      (ref.saleId !== null && t.sale_payme_id === ref.saleId),
  );
  if (mine.length === 0) {
    return {
      state: "pending",
      amount: null,
      echoedReference: null,
      merchantRef: null,
      rawRedacted: { rows: 0 },
    };
  }
  // One attempt is one sale; prefer the stored sale id when PayMe lists more than one.
  const saleId =
    ref.saleId ?? mine.find((t) => t.sale_payme_id)?.sale_payme_id ?? null;
  const sale = mine.filter((t) => !saleId || t.sale_payme_id === saleId);
  const head = sale[0] ?? mine[0];
  const charge = sale.find(
    (t) => isCharge(t) && t.transaction_error_code === SUCCESS_ERROR_CODE,
  );
  const status = (head?.sale_status ?? "").toLowerCase();
  let state: VerifiedState = SALE_STATE[status] ?? "pending";
  if (state === "succeeded" && !charge) state = "pending";
  const refundedMinor = sale
    .filter(
      (t) => isRefund(t) && t.transaction_error_code === SUCCESS_ERROR_CODE,
    )
    .reduce((sum, t) => sum + Math.abs(t.transaction_price ?? 0), 0);
  const price = charge?.transaction_price ?? head?.sale_price ?? null;
  const currency = currencyOf(head?.sale_currency);
  const card = (charge ?? head)?.sale_buyer_details;
  const mask = card?.buyer_card_mask ?? "";
  const last4 = /(\d{4})\s*$/.exec(mask)?.[1];
  const foreign = card?.buyer_card_is_foreign;
  return {
    state,
    ...(saleId ? { providerRef: saleId } : {}),
    amount:
      price !== null && currency
        ? { amountMinor: Math.round(price), currency }
        : null,
    echoedReference: ref.attemptId,
    merchantRef: sellerFingerprint(head?.seller_payme_id || ref.sellerId),
    ...(charge?.payme_transaction_id
      ? { transactionId: charge.payme_transaction_id }
      : {}),
    method: "credit-card",
    ...(charge?.sale_installments
      ? { installments: Math.round(charge.sale_installments) }
      : {}),
    ...(last4 ? { last4 } : {}),
    ...(card?.buyer_card_brand ? { brand: card.buyer_card_brand } : {}),
    ...(foreign === true || foreign === "true" || foreign === 1
      ? { isForeignCard: true }
      : foreign === false || foreign === "false" || foreign === 0
        ? { isForeignCard: false }
        : {}),
    ...(charge?.sale_auth_number
      ? { approvalCode: charge.sale_auth_number }
      : {}),
    ...(refundedMinor > 0 ? { refundedMinor } : {}),
    rawRedacted: redactTransactions(sale),
  };
}

/** What may be stored from `get-transactions` rows: no buyer details, card mask or seller key. */
export function redactTransactions(rows: PaymeTransaction[]) {
  return {
    rows: rows.map((t) => ({
      sale_status: t.sale_status ?? null,
      transaction_status: t.transaction_status ?? null,
      transaction_action: t.transaction_action ?? null,
      transaction_error_code: t.transaction_error_code ?? null,
      transaction_price: t.transaction_price ?? null,
      sale_currency: t.sale_currency ?? null,
      sale_installments: t.sale_installments ?? null,
      sale_is_3ds: t.sale_is_3ds ?? null,
    })),
  };
}

/** Completed charges of a period, for the daily sweep (unmatched money → CRITICAL alert). */
export function listedTransactions(
  rows: PaymeTransaction[],
): ListedTransaction[] {
  const out: ListedTransaction[] = [];
  for (const t of rows) {
    if (!isCharge(t) || t.transaction_error_code !== SUCCESS_ERROR_CODE)
      continue;
    const currency = currencyOf(t.sale_currency);
    const price = t.transaction_price ?? t.sale_price;
    if (!currency || price === null || price === undefined) continue;
    out.push({
      transactionId:
        t.payme_transaction_id ?? t.sale_payme_id ?? "unknown-transaction",
      amount: { amountMinor: Math.round(price), currency },
      ...(t.transaction_id ? { returnValue: t.transaction_id } : {}),
      ...(t.sale_payme_id ? { lowProfileId: t.sale_payme_id } : {}),
    });
  }
  return out;
}

/** `transaction_created_min/max` take "YYYY-MM-DD HH:mm:ss"; the sweep widens its window by a day. */
export function paymeDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------- callbacks

const SAFE_CALLBACK_FIELDS = [
  "notify_type",
  "sale_status",
  "payme_sale_id",
  "price",
  "currency",
  "installments",
  "status_code",
  "status_error_code",
] as const;

export function parseCallbackBody(raw: string): URLSearchParams {
  try {
    return new URLSearchParams(raw);
  } catch {
    return new URLSearchParams();
  }
}

/** Dedupe key for `payment_events`: the sale, the notification type and the sale status. */
export function callbackEventKey(body: URLSearchParams): string {
  const part = (k: string) => (body.get(k) || "none").slice(0, 80);
  return `pm:${part("payme_sale_id")}:${part("notify_type")}:${part("sale_status")}`;
}

/** The stored copy of a callback: no buyer name, email, phone, ID, card mask or signature. */
export function redactCallback(body: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_CALLBACK_FIELDS) {
    const v = body.get(k);
    if (v !== null) out[k] = v.slice(0, 120);
  }
  return out;
}

// ---------------------------------------------------------------- refund-sale

export function buildRefundSale(i: {
  clientKey: string;
  sellerId: string;
  saleId: string;
  amountMinor: number;
  isFull: boolean;
}): Record<string, unknown> {
  return {
    payme_client_key: i.clientKey,
    seller_payme_id: i.sellerId,
    payme_sale_id: i.saleId,
    ...(i.isFull ? {} : { sale_refund_amount: i.amountMinor }),
    language: "en",
  };
}

export const refundResponseSchema = z.looseObject({
  status_code: statusCode,
  sale_status: text,
  payme_transaction_id: text,
  status_error_code: text,
  status_error_details: text,
});
