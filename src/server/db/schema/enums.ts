import "server-only";
import { pgEnum } from "drizzle-orm/pg-core";

// Spec §3.2. Postgres enum type names are snake_case; values are the literal strings.

export const localeEnum = pgEnum("locale", ["he", "en"]);
export const currencyEnum = pgEnum("currency", ["ILS", "USD"]);

export const artworkSaleStatusEnum = pgEnum("artwork_sale_status", [
  "AVAILABLE",
  "ON_HOLD",
  "SOLD",
  "NOT_FOR_SALE",
]);
export const holdReasonEnum = pgEnum("hold_reason", [
  "EXHIBITION",
  "CONSIGNMENT",
  "PRIVATE_VIEWING",
  "RESERVED_OFFLINE",
  "OTHER",
]);
export const mediumEnum = pgEnum("medium", [
  "OIL",
  "ACRYLIC",
  "WATERCOLOR",
  "GOUACHE",
  "INK",
  "CHARCOAL",
  "PASTEL",
  "TEMPERA",
  "MIXED_MEDIA",
  "OTHER",
]);
export const surfaceEnum = pgEnum("surface", [
  "CANVAS",
  "LINEN",
  "WOOD_PANEL",
  "BOARD",
  "CARDBOARD",
  "PAPER",
  "OTHER",
]);
export const orientationEnum = pgEnum("orientation", [
  "PORTRAIT",
  "LANDSCAPE",
  "SQUARE",
  "PANORAMIC",
]);
export const sizeBucketEnum = pgEnum("size_bucket", ["S", "M", "L", "XL"]);
export const imageRoleEnum = pgEnum("image_role", [
  "MAIN",
  "DETAIL",
  "EDGE",
  "BACK",
  "FRAMED",
  "IN_ROOM",
  "PROCESS",
]);
export const packagingTypeEnum = pgEnum("packaging_type", [
  "ROLLED_TUBE",
  "FLAT_BOX",
  "STRETCHED_BOX",
  "FRAMED_BOX",
  "CRATE",
]);
export const glazingEnum = pgEnum("glazing", ["NONE", "GLASS", "ACRYLIC"]);
export const sizeClassEnum = pgEnum("size_class", ["S", "M", "L", "QUOTE"]);

export const orderStatusEnum = pgEnum("order_status", [
  "AWAITING_PAYMENT",
  "PAYMENT_REVIEW",
  "PAID",
  "EXPIRED",
  "CANCELLED",
  "COMPLETED",
]);
export const orderSourceEnum = pgEnum("order_source", [
  "WEB",
  "OFFER",
  "QUOTE",
  "MANUAL",
]);
export const shippingMethodEnum = pgEnum("shipping_method", [
  "CARRIER_TABLE",
  "LOCAL_PICKUP",
  "ARTIST_DELIVERY",
  "QUOTED",
]);
export const vatModeEnum = pgEnum("vat_mode", ["OSEK_PATUR", "OSEK_MURSHE"]);

export const paymentProviderEnum = pgEnum("payment_provider", [
  "MOCK",
  "CARDCOM",
  "PAYPAL",
  "OFFLINE",
]);
export const providerModeEnum = pgEnum("provider_mode", [
  "MOCK",
  "TEST",
  "LIVE",
  "MANUAL",
]);
export const attemptStatusEnum = pgEnum("attempt_status", [
  "CREATED",
  "PENDING",
  "AWAITING_CAPTURE",
  "CAPTURING",
  "PAYMENT_REVIEW",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "EXPIRED",
  "NEEDS_REFUND",
  "REFUNDED",
]);
export const refundReasonEnum = pgEnum("refund_reason", [
  "CANCELLATION",
  "LOST_RESERVATION",
  "DUPLICATE_PAYMENT",
  "ORDER_CANCELLED",
  "STALE_QUOTE",
  "AMOUNT_MISMATCH",
  "ADMIN",
  "EXTERNAL",
]);
export const refundStatusEnum = pgEnum("refund_status", [
  "REQUESTED",
  "IN_FLIGHT",
  "PROVIDER_PENDING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "MANUAL_REQUIRED",
  "MANUAL_DONE",
]);
export const saleChannelEnum = pgEnum("sale_channel", ["ONLINE", "OFFLINE"]);

export const taxdocKindEnum = pgEnum("taxdoc_kind", [
  "RECEIPT",
  "INVOICE_RECEIPT",
  "CREDIT_NOTE",
]);
export const taxdocProviderEnum = pgEnum("taxdoc_provider", [
  "MOCK",
  "MORNING",
  "CARDCOM_GATEWAY",
  "MANUAL",
]);
export const taxdocStatusEnum = pgEnum("taxdoc_status", [
  "ISSUING",
  "UNKNOWN",
  "ISSUED",
  "FAILED",
  "NEEDS_MANUAL",
]);
export const generatedDocKindEnum = pgEnum("generated_doc_kind", [
  "DISCLOSURE",
  "COA",
]);

export const shipmentStatusEnum = pgEnum("shipment_status", [
  "AWAITING_FULFILLMENT",
  "PACKED",
  "LABEL_REQUESTED",
  "LABEL_UNKNOWN",
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "RETURNED",
  "CANCELLED",
  "READY_FOR_PICKUP",
  "COLLECTED",
]);
export const carrierEnum = pgEnum("carrier", ["MOCK", "MANUAL", "DHL"]);
export const eventSourceEnum = pgEnum("event_source", [
  "MANUAL",
  "POLL",
  "WEBHOOK",
  "SYSTEM",
]);
export const exportDeclStatusEnum = pgEnum("export_decl_status", [
  "NOT_REQUIRED",
  "REQUIRED",
  "PENDING_CARRIER",
  "RECORDED",
]);

export const requestKindEnum = pgEnum("request_kind", [
  "QUESTION",
  "OFFER",
  "QUOTE",
]);
export const requestStatusEnum = pgEnum("request_status", [
  "NEW",
  "REPLIED",
  "ACCEPTED",
  "COUNTERED",
  "QUOTED",
  "DECLINED",
  "AUTO_DECLINED",
  "CONVERTED",
  "EXPIRED",
  "CLOSED",
]);

export const cancellationRegimeEnum = pgEnum("cancellation_regime", [
  "IL",
  "EU",
]);
export const cancellationStatusEnum = pgEnum("cancellation_status", [
  "RECEIVED",
  "ACCEPTED",
  "REJECTED",
  "CLOSED",
]);
export const returnStatusEnum = pgEnum("return_status", [
  "NOT_APPLICABLE",
  "AWAITING_RETURN",
  "RECEIVED",
  "INSPECTED_OK",
  "INSPECTED_DAMAGED",
]);
export const cancellationChannelEnum = pgEnum("cancellation_channel", [
  "WEB",
  "PHONE",
  "EMAIL",
  "REGISTERED_MAIL",
  "IN_PERSON",
]);
export const cancellationReasonEnum = pgEnum("cancellation_reason", [
  "CHANGE_OF_MIND",
  "DEFECT",
  "NOT_AS_DESCRIBED",
  "NOT_DELIVERED",
  "OTHER",
]);
export const eligibleGroupEnum = pgEnum("eligible_group", [
  "NONE",
  "SENIOR_65",
  "DISABILITY",
  "NEW_IMMIGRANT",
]);

export const jobKindEnum = pgEnum("job_kind", [
  "SEND_EMAIL",
  "ISSUE_TAX_DOCUMENT",
  "ISSUE_CREDIT_NOTE",
  "REFUND_PAYMENT",
  "REFUND_SETTLED",
]);
export const jobStatusEnum = pgEnum("job_status", [
  "PENDING",
  "RUNNING",
  "DONE",
  "DEAD",
]);
export const alertSeverityEnum = pgEnum("alert_severity", [
  "INFO",
  "WARNING",
  "CRITICAL",
]);

// Text columns with a fixed vocabulary (CHECK-constrained in the tables, not Postgres enums).
export const ORDER_STATUS_REASONS = [
  "LOST_RESERVATION",
  "BUYER_CANCELLATION",
  "ADMIN",
  "RELEASED",
  "HOLD_TAKEN_OVER",
  "LINK_EXPIRED",
  "HOLD_EXPIRED",
  "STALE_QUOTE",
] as const;
export type OrderStatusReason = (typeof ORDER_STATUS_REASONS)[number];

export const FULFILLMENT_BLOCKED_REASONS = [
  "PAYMENT_REVIEW",
  "DISPUTE",
  "PAYMENT_REVERSED",
  "EXTERNAL_REFUND",
  "PENDING_CANCELLATION",
] as const;
export type FulfillmentBlockedReason =
  (typeof FULFILLMENT_BLOCKED_REASONS)[number];

export const REQUEST_TOPICS = [
  "GENERAL",
  "COMMISSION",
  "AVAILABILITY",
  "SIMILAR_WORKS",
] as const;
export type RequestTopic = (typeof REQUEST_TOPICS)[number];

export const MOCK_PAYMENT_FLOWS = ["DIRECT", "CAPTURE"] as const;
export type MockPaymentFlow = (typeof MOCK_PAYMENT_FLOWS)[number];

export const MOCK_PAYMENT_STATES = [
  "OPEN",
  "APPROVED",
  "PAID",
  "REVIEW",
  "DECLINED",
  "CANCELED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;
export type MockPaymentState = (typeof MOCK_PAYMENT_STATES)[number];

export const EMAIL_MESSAGE_STATUSES = ["PENDING", "SENT", "FAILED"] as const;
export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number];

export const SETTINGS_KEYS = [
  "business_profile",
  "checkout",
  "shipping",
  "cancellation_policy",
  "site_content",
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
