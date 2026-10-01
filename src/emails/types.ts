/**
 * Email template contract (spec §4.5, §9.3 frozen): the `EmailTemplateId` union and the props of
 * every template. UI-layer module (no `@/server` imports); `src/server/email/types.ts` re-exports it.
 *
 * Props are display data only (strings, minor units, ISO dates); the `SEND_EMAIL` handler loads
 * fresh data and builds them at send time. Painter templates always render in Hebrew.
 * There is no advertising template (s.30A).
 */
import type { ReactElement } from "react";
import type { DisclosureDoc } from "@/content/disclosure";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";

export const BUYER_TEMPLATE_IDS = [
  "order-confirmation",
  "payment-review",
  "purchase-not-completed",
  "shipment-update",
  "ready-for-pickup",
  "receipt",
  "checkout-link",
  "request-ack",
  "request-reply",
  "cancellation-ack",
  "return-instructions",
  "refund-issued",
] as const;

export const PAINTER_TEMPLATE_IDS = [
  "painter-new-order",
  "painter-new-request",
  "painter-cancellation",
  "admin-alert",
] as const;

export const EMAIL_TEMPLATE_IDS = [
  ...BUYER_TEMPLATE_IDS,
  ...PAINTER_TEMPLATE_IDS,
] as const;

export type BuyerTemplateId = (typeof BUYER_TEMPLATE_IDS)[number];
export type PainterTemplateId = (typeof PAINTER_TEMPLATE_IDS)[number];
export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];

export function isPainterTemplate(
  id: EmailTemplateId,
): id is PainterTemplateId {
  return (PAINTER_TEMPLATE_IDS as readonly string[]).includes(id);
}

/** Translator over the merged message tree, keys like `emails-core.greeting`. */
export type EmailT = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

/** Seller identity for the footer. Deliberately has no ID number field (spec §4.5). */
export interface EmailBrand {
  tradeName: string;
  address: string;
  email: string;
  phone: string;
  /** `${APP_URL}/${locale}/cancel` */
  cancelUrl: string;
  siteUrl: string;
}

export interface EmailContext {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: EmailT;
  brand: EmailBrand;
  /** DEMO_MODE: the footer says no real payment was taken. */
  demo: boolean;
}

export interface MoneyLine {
  title: string;
  amountMinor: number;
}

/** Buyer emails about an order link to the order page (`?k=` token URL). */
export interface OrderRef {
  orderNumber: string;
  buyerName: string;
  orderUrl: string;
}

export type ShipmentStatusValue =
  | "AWAITING_FULFILLMENT"
  | "PACKED"
  | "LABEL_REQUESTED"
  | "LABEL_UNKNOWN"
  | "LABEL_CREATED"
  | "PICKUP_SCHEDULED"
  | "IN_TRANSIT"
  | "CUSTOMS"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "EXCEPTION"
  | "RETURNED"
  | "CANCELLED"
  | "READY_FOR_PICKUP"
  | "COLLECTED";

export type NotCompletedReason =
  | "LOST_RESERVATION"
  | "LOST_BEFORE_CAPTURE"
  | "DUPLICATE_PAYMENT"
  | "STALE_QUOTE"
  | "ORDER_CANCELLED"
  | "AMOUNT_MISMATCH";

export type CancellationChannelValue =
  | "WEB"
  | "PHONE"
  | "EMAIL"
  | "REGISTERED_MAIL"
  | "IN_PERSON";

export interface EmailTemplateProps {
  "order-confirmation": OrderRef & {
    items: MoneyLine[];
    currency: Currency;
    shippingMinor: number;
    insuranceMinor: number;
    totalMinor: number;
    paidAt: string;
    /** Inline summary source (spec §5.4); the PDF attachment is Tier B. */
    disclosure: DisclosureDoc;
    disclosureUrl: string;
  };
  "payment-review": OrderRef;
  "purchase-not-completed": OrderRef & {
    reason: NotCompletedReason;
    /** False: "you were not charged". True: a refund is on its way. */
    charged: boolean;
    refundAmountMinor?: number;
    currency: Currency;
  };
  "shipment-update": OrderRef & {
    status: ShipmentStatusValue;
    carrierName: string;
    trackingNumber?: string;
    trackingUrl?: string;
    estimatedDeliveryAt?: string;
    /** Data shown "Delivered by Deutsche Post DHL Group" (spec §5.6). */
    dhlAttribution: boolean;
  };
  "ready-for-pickup": OrderRef & {
    pickupAddress: string;
    pickupInstructions: string;
  };
  receipt: OrderRef & {
    docNumber: string;
    docUrl: string;
    /** Mock documents are stamped "DEMO – not a tax document". */
    isDemoDocument: boolean;
  };
  "checkout-link": OrderRef & {
    artworkTitle: string;
    payUrl: string;
    expiresAt: string;
    totalMinor: number;
    currency: Currency;
  };
  "request-ack": {
    name: string;
    kind: "QUESTION" | "OFFER" | "QUOTE";
    artworkTitle?: string;
    message: string;
  };
  "request-reply": {
    name: string;
    artworkTitle?: string;
    reply: string;
  };
  "cancellation-ack": {
    cancellationNumber: string;
    fullName: string;
    /** Always masked (`•••••••12`); the full ID never reaches an email (spec §7). */
    idNumberMasked?: string;
    orderNumber?: string;
    channel: CancellationChannelValue;
    receivedAt: string;
    refundDueAt: string;
    message?: string;
  };
  "return-instructions": OrderRef & {
    cancellationNumber: string;
    returnAddress: string;
    instructions?: string;
    refundAmountMinor: number;
    currency: Currency;
  };
  "refund-issued": OrderRef & {
    amountMinor: number;
    currency: Currency;
    creditNoteUrl?: string;
  };
  "painter-new-order": {
    orderNumber: string;
    adminOrderUrl: string;
    buyerName: string;
    buyerCountry: string;
    items: MoneyLine[];
    totalMinor: number;
    currency: Currency;
    isDemo: boolean;
  };
  "painter-new-request": {
    adminRequestUrl: string;
    kind: "QUESTION" | "OFFER" | "QUOTE";
    name: string;
    email: string;
    country?: string;
    artworkTitle?: string;
    message: string;
    offerAmountMinor?: number;
    offerCurrency?: Currency;
  };
  "painter-cancellation": {
    cancellationNumber: string;
    adminCancellationUrl: string;
    fullName: string;
    idNumberMasked?: string;
    orderNumber?: string;
    channel: CancellationChannelValue;
    receivedAt: string;
    refundDueAt: string;
    possibleDuplicate: boolean;
  };
  "admin-alert": {
    severity: "INFO" | "WARNING" | "CRITICAL";
    kind: string;
    message: string;
    adminAlertsUrl: string;
  };
}

/** One template module: subject line plus the React component. */
export interface EmailTemplate<P> {
  audience: "buyer" | "painter";
  subject: (props: P, ctx: EmailContext) => string;
  /** Preview text (first line shown by mail clients). */
  preview: (props: P, ctx: EmailContext) => string;
  Component: (args: { props: P; ctx: EmailContext }) => ReactElement;
}

export type EmailTemplateRegistry = {
  [K in EmailTemplateId]: EmailTemplate<EmailTemplateProps[K]>;
};
