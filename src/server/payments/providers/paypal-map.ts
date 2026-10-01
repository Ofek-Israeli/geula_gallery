import "server-only";
import type { Locale } from "@/lib/locale";
import {
  type Currency,
  fromDecimal,
  isCurrency,
  type Money,
  sumMinor,
  toDecimalString,
} from "@/lib/money";
import type { components as Orders } from "@/server/integrations/generated/paypal-checkout-orders-v2";
import type { components as Payments } from "@/server/integrations/generated/paypal-payments-v2";
import type {
  CreateCheckoutInput,
  RefundStatusResult,
  VerifiedPayment,
  VerifiedState,
} from "../types";

/**
 * Pure PayPal Orders v2 / Payments v2 mapping (spec §4.2 `paypal`, §10.1 `paypal-map`).
 *
 * | PayPal status                                   | VerifiedState                 |
 * |-------------------------------------------------|-------------------------------|
 * | CREATED, SAVED, PAYER_ACTION_REQUIRED           | pending                       |
 * | APPROVED (no capture yet)                       | requires_capture              |
 * | capture COMPLETED                               | succeeded                     |
 * | capture PENDING                                 | review                        |
 * | capture DECLINED / FAILED                       | failed                        |
 * | capture REFUNDED / PARTIALLY_REFUNDED           | refunded / partially_refunded |
 * | VOIDED                                          | canceled                      |
 *
 * `echoedReference` = `purchase_units[0].custom_id` (the attempt id), `merchantRef` =
 * `purchase_units[0].payee.merchant_id` (compared with `PAYPAL_MERCHANT_ID` by finalize).
 */
type OrderSchemas = Orders["schemas"];
export type PaypalOrderRequest = OrderSchemas["order_request"];
export type PaypalOrder = OrderSchemas["order"];
export type PaypalRefundRequest = Payments["schemas"]["refund_request"];
export type PaypalRefund = Payments["schemas"]["refund"];

/** Minor units → PayPal's 2-decimal money object (ILS and USD both have 2 decimals). */
export function paypalMoney(m: Money): {
  currency_code: string;
  value: string;
} {
  return { currency_code: m.currency, value: toDecimalString(m.amountMinor) };
}

/** PayPal money object → Money, or null when the currency or value is unusable. */
export function moneyFromPaypal(value: unknown): Money | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { currency_code?: unknown; value?: unknown };
  if (!isCurrency(v.currency_code) || typeof v.value !== "string") return null;
  try {
    return { amountMinor: fromDecimal(v.value), currency: v.currency_code };
  } catch {
    return null;
  }
}

const PAYPAL_LOCALE: Record<Locale, string> = { he: "he-IL", en: "en-US" };

/** `<orderNumber>-<seq>`: unique per attempt (PayPal rejects a reused invoice_id). */
export function paypalInvoiceId(
  orderNumber: string,
  attemptSeq: number,
): string {
  return `${orderNumber}-${attemptSeq}`;
}

const clip = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * `POST /v2/checkout/orders` body. Items and the breakdown are sent only when they add up to the
 * attempt amount exactly (PayPal rejects a mismatched breakdown); otherwise the amount alone.
 */
export function buildOrderRequest(
  i: CreateCheckoutInput,
  opts: { brandName?: string },
): PaypalOrderRequest {
  const currency: Currency = i.amount.currency;
  const sameCurrency = [
    ...i.lines.map((l) => l.amount),
    i.shipping,
    i.insurance,
  ].every((m) => m.currency === currency);
  const itemTotal = sumMinor(i.lines.map((l) => l.amount.amountMinor));
  const consistent =
    sameCurrency &&
    i.lines.length > 0 &&
    itemTotal + i.shipping.amountMinor + i.insurance.amountMinor ===
      i.amount.amountMinor;

  const shipTo = i.shipTo;
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        custom_id: i.attemptId,
        invoice_id: paypalInvoiceId(i.orderNumber, i.attemptSeq),
        description: clip(`Order ${i.orderNumber}`, 127),
        amount: {
          ...paypalMoney(i.amount),
          ...(consistent
            ? {
                breakdown: {
                  item_total: paypalMoney({ amountMinor: itemTotal, currency }),
                  shipping: paypalMoney(i.shipping),
                  insurance: paypalMoney(i.insurance),
                },
              }
            : {}),
        },
        ...(consistent
          ? {
              items: i.lines.map((l) => ({
                name: clip(l.name, 127),
                unit_amount: paypalMoney(l.amount),
                quantity: "1",
                category: "PHYSICAL_GOODS" as const,
              })),
            }
          : {}),
        ...(shipTo
          ? {
              shipping: {
                type: "SHIPPING" as const,
                name: { full_name: clip(shipTo.name, 300) },
                address: {
                  address_line_1: clip(shipTo.line1, 300),
                  ...(shipTo.line2
                    ? { address_line_2: clip(shipTo.line2, 300) }
                    : {}),
                  admin_area_2: clip(shipTo.city, 120),
                  ...(shipTo.region
                    ? { admin_area_1: clip(shipTo.region, 300) }
                    : {}),
                  ...(shipTo.postalCode
                    ? { postal_code: clip(shipTo.postalCode, 60) }
                    : {}),
                  country_code: shipTo.country,
                },
              },
            }
          : {}),
      },
    ],
    payment_source: {
      paypal: {
        ...(i.buyer ? { email_address: i.buyer.email } : {}),
        experience_context: {
          return_url: i.returnUrl,
          cancel_url: i.cancelUrl,
          user_action: "PAY_NOW",
          landing_page: "NO_PREFERENCE",
          locale: PAYPAL_LOCALE[i.locale],
          ...(opts.brandName ? { brand_name: clip(opts.brandName, 127) } : {}),
          shipping_preference: shipTo ? "SET_PROVIDED_ADDRESS" : "NO_SHIPPING",
          contact_preference: "NO_CONTACT_INFO",
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
        },
      },
    },
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function linksOf(raw: unknown): { href: string; rel: string }[] {
  const links = asRecord(raw).links;
  if (!Array.isArray(links)) return [];
  return links.flatMap((l) => {
    const r = asRecord(l);
    return typeof r.href === "string" && typeof r.rel === "string"
      ? [{ href: r.href, rel: r.rel }]
      : [];
  });
}

/** The buyer redirect: the link with `rel === "payer-action"` (or legacy `approve`). */
export function payerActionUrl(order: unknown): string {
  const links = linksOf(order);
  const link =
    links.find((l) => l.rel === "payer-action") ??
    links.find((l) => l.rel === "approve");
  if (!link) throw new Error("PayPal order has no payer-action link");
  return link.href;
}

/** A link by relation (e.g. a capture's `up` link to its order). */
export function linkHref(resource: unknown, rel: string): string | null {
  return linksOf(resource).find((l) => l.rel === rel)?.href ?? null;
}

const CAPTURE_STATE: Record<string, VerifiedState> = {
  COMPLETED: "succeeded",
  PENDING: "review",
  DECLINED: "failed",
  FAILED: "failed",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
};

const ORDER_STATE: Record<string, VerifiedState> = {
  CREATED: "pending",
  SAVED: "pending",
  PAYER_ACTION_REQUIRED: "pending",
  APPROVED: "requires_capture",
  VOIDED: "canceled",
  // COMPLETED without a readable capture: money moved but cannot be verified → review.
  COMPLETED: "review",
};

/** Keeps only non-PII fields of an order for storage (`raw_redacted`). */
export function redactPaypalOrder(raw: unknown): unknown {
  const o = asRecord(raw);
  const units = Array.isArray(o.purchase_units) ? o.purchase_units : [];
  return {
    id: o.id,
    status: o.status,
    intent: o.intent,
    purchase_units: units.map((u) => {
      const pu = asRecord(u);
      const payments = asRecord(pu.payments);
      const pick = (list: unknown) =>
        Array.isArray(list)
          ? list.map((x) => {
              const r = asRecord(x);
              return {
                id: r.id,
                status: r.status,
                amount: r.amount,
                custom_id: r.custom_id,
                invoice_id: r.invoice_id,
                final_capture: r.final_capture,
                status_details: r.status_details,
              };
            })
          : undefined;
      return {
        reference_id: pu.reference_id,
        custom_id: pu.custom_id,
        invoice_id: pu.invoice_id,
        amount: pu.amount,
        payee: { merchant_id: asRecord(pu.payee).merchant_id },
        payments: {
          captures: pick(payments.captures),
          refunds: pick(payments.refunds),
        },
      };
    }),
  };
}

/** Order (GET, or a capture with `Prefer: return=representation`) → `VerifiedPayment`. */
export function mapPaypalOrder(raw: unknown): VerifiedPayment {
  const o = asRecord(raw);
  const units = Array.isArray(o.purchase_units) ? o.purchase_units : [];
  const pu = asRecord(units[0]);
  const payments = asRecord(pu.payments);
  const captures = Array.isArray(payments.captures) ? payments.captures : [];
  const capture = asRecord(
    // Prefer a COMPLETED capture, then the most recent one.
    captures.find((c) => asRecord(c).status === "COMPLETED") ??
      captures[captures.length - 1],
  );
  const hasCapture = typeof capture.id === "string";
  const orderStatus = typeof o.status === "string" ? o.status : "";
  const captureStatus =
    typeof capture.status === "string" ? capture.status : "";

  let state: VerifiedState;
  if (orderStatus === "VOIDED") state = "canceled";
  else if (hasCapture) state = CAPTURE_STATE[captureStatus] ?? "review";
  else state = ORDER_STATE[orderStatus] ?? "pending";

  const refunds = Array.isArray(payments.refunds) ? payments.refunds : [];
  const refundedMinor = refunds
    .map(asRecord)
    .filter((r) => r.status === "COMPLETED")
    .map((r) => moneyFromPaypal(r.amount)?.amountMinor ?? 0)
    .reduce((a, b) => a + b, 0);

  const amount = hasCapture
    ? moneyFromPaypal(capture.amount)
    : moneyFromPaypal(pu.amount);
  const customId =
    typeof pu.custom_id === "string"
      ? pu.custom_id
      : typeof capture.custom_id === "string"
        ? capture.custom_id
        : null;
  const merchantId = asRecord(pu.payee).merchant_id;

  return {
    state,
    amount,
    echoedReference: customId,
    merchantRef: typeof merchantId === "string" ? merchantId : null,
    ...(hasCapture
      ? { transactionId: capture.id as string, captureId: capture.id as string }
      : {}),
    method: "paypal",
    ...(refunds.length > 0 ? { refundedMinor } : {}),
    rawRedacted: redactPaypalOrder(raw),
  };
}

/** `POST /v2/payments/captures/{id}/refund` body (`custom_id` = our refund id, never shown to the buyer). */
export function buildRefundRequest(i: {
  refundId: string;
  amount: Money;
  invoiceRef: string;
}): PaypalRefundRequest {
  return {
    amount: paypalMoney(i.amount),
    custom_id: i.refundId,
    invoice_id: i.invoiceRef,
  };
}

export function mapRefundStatus(status: unknown): RefundStatusResult["status"] {
  switch (status) {
    case "COMPLETED":
      return "succeeded";
    case "PENDING":
      return "pending";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      return "pending";
  }
}

export function redactPaypalRefund(raw: unknown): unknown {
  const r = asRecord(raw);
  return {
    id: r.id,
    status: r.status,
    amount: r.amount,
    custom_id: r.custom_id,
    invoice_id: r.invoice_id,
    status_details: r.status_details,
  };
}

// ---------------------------------------------------------------- webhooks

/** Event types that reach finalization vs. the post-success sync (spec §4.2 "Events"). */
export const PAYPAL_FINALIZE_EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "CHECKOUT.ORDER.APPROVED",
] as const;
export const PAYPAL_POST_SUCCESS_EVENTS = [
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "CUSTOMER.DISPUTE.CREATED",
] as const;

export interface PaypalEventHints {
  eventKey: string;
  eventType?: string;
  attemptId?: string;
  providerRef?: string;
  refundCustomId?: string;
  payloadRedacted: unknown;
}

/**
 * Webhook event → hints. `eventKey` = `event.id`. Capture events carry the attempt id in
 * `resource.custom_id` and the order id in `supplementary_data.related_ids.order_id`; refund
 * events carry our refund id in `resource.custom_id` (`refundCustomId`).
 */
export function parsePaypalEvent(rawBody: string): PaypalEventHints {
  let event: Record<string, unknown> = {};
  try {
    event = asRecord(JSON.parse(rawBody));
  } catch {
    event = {};
  }
  const id = typeof event.id === "string" ? event.id : "unknown";
  const eventType =
    typeof event.event_type === "string" ? event.event_type : undefined;
  const resource = asRecord(event.resource);
  const related = asRecord(asRecord(resource.supplementary_data).related_ids);
  const isRefund =
    eventType === "PAYMENT.CAPTURE.REFUNDED" ||
    event.resource_type === "refund";
  const isOrder = event.resource_type === "checkout-order";
  const customId =
    typeof resource.custom_id === "string" ? resource.custom_id : undefined;
  const orderPu = asRecord(
    Array.isArray(resource.purchase_units) ? resource.purchase_units[0] : null,
  );
  const providerRef = isOrder
    ? typeof resource.id === "string"
      ? resource.id
      : undefined
    : typeof related.order_id === "string"
      ? related.order_id
      : undefined;
  const attemptId = isRefund
    ? undefined
    : isOrder
      ? typeof orderPu.custom_id === "string"
        ? orderPu.custom_id
        : undefined
      : customId;
  return {
    eventKey: id,
    ...(eventType ? { eventType } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(providerRef ? { providerRef } : {}),
    ...(isRefund && customId ? { refundCustomId: customId } : {}),
    payloadRedacted: {
      id: event.id,
      event_type: event.event_type,
      resource_type: event.resource_type,
      create_time: event.create_time,
      resource: {
        id: resource.id,
        status: resource.status,
        amount: resource.amount,
        custom_id: resource.custom_id,
        invoice_id: resource.invoice_id,
        ...(providerRef ? { order_id: providerRef } : {}),
        ...postSuccessRefs(resource),
      },
    },
  };
}

/**
 * The capture references `webhook.ts#PostSuccessPayload` reads for refund / reversal / dispute
 * events: the refund's `up` link (to the capture) and the disputed capture ids. Nothing else of
 * those arrays is kept (no PII).
 */
function postSuccessRefs(resource: Record<string, unknown>): {
  links?: { rel: string; href: string }[];
  disputed_transactions?: { seller_transaction_id: string }[];
} {
  const links = (Array.isArray(resource.links) ? resource.links : [])
    .map(asRecord)
    .filter(
      (l): l is { rel: string; href: string } =>
        l.rel === "up" && typeof l.href === "string",
    )
    .map((l) => ({ rel: l.rel, href: l.href }));
  const disputed = (
    Array.isArray(resource.disputed_transactions)
      ? resource.disputed_transactions
      : []
  )
    .map((t) => asRecord(t).seller_transaction_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => ({ seller_transaction_id: id }));
  return {
    ...(links.length > 0 ? { links } : {}),
    ...(disputed.length > 0 ? { disputed_transactions: disputed } : {}),
  };
}
