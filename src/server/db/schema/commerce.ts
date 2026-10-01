import "server-only";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { artworks } from "./catalog";
import { sqlInList, timestamps, tstz } from "./columns";
import { cancellations } from "./compliance";
import {
  attemptStatusEnum,
  currencyEnum,
  FULFILLMENT_BLOCKED_REASONS,
  type FulfillmentBlockedReason,
  generatedDocKindEnum,
  localeEnum,
  MOCK_PAYMENT_FLOWS,
  MOCK_PAYMENT_STATES,
  type MockPaymentFlow,
  type MockPaymentState,
  ORDER_STATUS_REASONS,
  type OrderStatusReason,
  orderSourceEnum,
  orderStatusEnum,
  paymentProviderEnum,
  providerModeEnum,
  refundReasonEnum,
  refundStatusEnum,
  saleChannelEnum,
  shippingMethodEnum,
  taxdocKindEnum,
  taxdocProviderEnum,
  taxdocStatusEnum,
  vatModeEnum,
} from "./enums";

export const orders = pgTable(
  "orders",
  {
    // Identity
    id: uuid().primaryKey().defaultRandom(),
    /** `GG-` + 6 Crockford base32 characters. */
    number: text().notNull().unique(),
    clientRequestId: uuid().unique("orders_client_request_id_unique"),
    source: orderSourceEnum().notNull().default("WEB"),
    status: orderStatusEnum().notNull().default("AWAITING_PAYMENT"),
    statusReason: text().$type<OrderStatusReason>(),
    locale: localeEnum().notNull(),
    currency: currencyEnum().notNull(),
    isDemo: boolean().notNull().default(false),

    // Amounts (integer minor units)
    itemsTotalMinor: integer().notNull(),
    shippingMinor: integer().notNull().default(0),
    insuranceMinor: integer().notNull().default(0),
    totalMinor: integer().notNull(),
    vatMode: vatModeEnum().notNull(),
    vatRateBp: integer().notNull().default(0),
    vatMinor: integer().notNull().default(0),
    /** Reference only; never used to compute a charged amount. */
    fxIlsPerUnit: numeric({ precision: 12, scale: 6 }),

    // Quote lock: bumped by every change to items, amounts, currency, shipping (checkout/requote.ts)
    quoteVersion: integer().notNull().default(1),

    // Buyer (nullable until completed; anonymised later)
    buyerName: text(),
    buyerEmail: text(),
    buyerPhone: text(),
    buyerCompanyName: text(),
    buyerVatId: text(),

    // Shipping address
    shipCountry: char({ length: 2 }).notNull(),
    shipName: text(),
    shipLine1: text(),
    shipLine2: text(),
    shipCity: text(),
    shipRegion: text(),
    shipPostalCode: text(),
    shipPhone: text(),
    shippingMethod: shippingMethodEnum().notNull(),
    shippingQuote: jsonb(),
    shippingLocked: boolean().notNull().default(false),

    // Consents
    termsVersion: text(),
    returnsVersion: text(),
    privacyVersion: text(),
    termsAcceptedAt: tstz(),
    ageConfirmedAt: tstz(),
    dutiesNoticeVersion: text(),
    dutiesAckAt: tstz(),
    receiptEmailConsent: boolean().notNull().default(false),

    // Compliance
    conversationTookPlace: boolean().notNull().default(false),
    /** `REQUEST:<id>` | `LINK` | `ADMIN` | null */
    conversationSource: text(),
    disclosureVersion: text(),
    disclosureSentAt: tstz(),
    disclosureHandedOverAt: tstz(),
    deliveredAt: tstz(),
    cancellationWindowEndsAt: tstz(),
    fulfillmentBlockedReason: text().$type<FulfillmentBlockedReason>(),

    // Lifecycle
    expiresAt: tstz(),
    holdCount: smallint().notNull().default(0),
    firstHeldAt: tstz(),
    paidAttemptId: uuid().references((): AnyPgColumn => paymentAttempts.id, {
      onDelete: "restrict",
    }),
    paidAt: tstz(),
    cancelledAt: tstz(),
    completedAt: tstz(),

    // Access
    accessVersion: integer().notNull().default(1),
    clientIpHash: text(),
    adminNotes: text(),
    anonymizedAt: tstz(),

    ...timestamps,
  },
  (t) => [
    check(
      "orders_amounts_nonnegative",
      sql`${t.itemsTotalMinor} >= 0 AND ${t.shippingMinor} >= 0 AND ${t.insuranceMinor} >= 0 AND ${t.totalMinor} >= 0 AND ${t.vatMinor} >= 0 AND ${t.vatRateBp} >= 0`,
    ),
    check(
      "orders_total_sum",
      sql`${t.totalMinor} = ${t.itemsTotalMinor} + ${t.shippingMinor} + ${t.insuranceMinor}`,
    ),
    check(
      "orders_il_pays_ils",
      sql`${t.shipCountry} <> 'IL' OR ${t.currency} = 'ILS'`,
    ),
    check("orders_vat_le_total", sql`${t.vatMinor} <= ${t.totalMinor}`),
    check(
      "orders_paid_has_attempt",
      sql`${t.status} NOT IN ('PAID', 'COMPLETED') OR ${t.paidAttemptId} IS NOT NULL`,
    ),
    check(
      "orders_status_reason_values",
      sql`${t.statusReason} IS NULL OR ${t.statusReason} IN (${sqlInList(ORDER_STATUS_REASONS)})`,
    ),
    check(
      "orders_fulfillment_blocked_reason_values",
      sql`${t.fulfillmentBlockedReason} IS NULL OR ${t.fulfillmentBlockedReason} IN (${sqlInList(FULFILLMENT_BLOCKED_REASONS)})`,
    ),
    check(
      "orders_conversation_source_format",
      sql`${t.conversationSource} IS NULL OR ${t.conversationSource} ~ '^(REQUEST:.+|LINK|ADMIN)$'`,
    ),
    check(
      "orders_counters_nonnegative",
      sql`${t.holdCount} >= 0 AND ${t.quoteVersion} >= 1 AND ${t.accessVersion} >= 1`,
    ),
    check("orders_ship_country_upper", sql`${t.shipCountry} ~ '^[A-Z]{2}$'`),
    index("orders_status_expires_idx").on(t.status, t.expiresAt),
    index("orders_buyer_email_idx").on(sql`lower(${t.buyerEmail})`),
    index("orders_client_ip_created_idx").on(t.clientIpHash, t.createdAt),
    index("orders_created_desc_idx").on(t.createdAt.desc()),
  ],
);

/** Immutable after insert; a requote that changes items creates a new order. */
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    artworkId: uuid()
      .notNull()
      .references(() => artworks.id, { onDelete: "restrict" }),
    titleHe: text().notNull(),
    titleEn: text().notNull(),
    priceMinor: integer().notNull(),
    currency: currencyEnum().notNull(),
    declaredValueMinor: integer(),
    snapshot: jsonb().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    unique("order_items_order_artwork_uq").on(t.orderId, t.artworkId),
    check(
      "order_items_amounts",
      sql`${t.priceMinor} >= 0 AND (${t.declaredValueMinor} IS NULL OR ${t.declaredValueMinor} >= 0)`,
    ),
    index("order_items_artwork_idx").on(t.artworkId),
  ],
);

/** The structural one-sale guarantee (spec §3.4). */
export const sales = pgTable(
  "sales",
  {
    id: uuid().primaryKey().defaultRandom(),
    artworkId: uuid()
      .notNull()
      .references(() => artworks.id, { onDelete: "restrict" }),
    orderId: uuid().references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: uuid().references(() => orderItems.id, {
      onDelete: "restrict",
    }),
    channel: saleChannelEnum().notNull(),
    priceMinor: integer().notNull(),
    currency: currencyEnum().notNull(),
    isMock: boolean().notNull().default(false),
    soldAt: tstz().notNull().defaultNow(),
    voidedAt: tstz(),
    voidReason: text(),
    createdBy: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sales_one_active_per_artwork_idx")
      .on(t.artworkId)
      .where(sql`${t.voidedAt} IS NULL`),
    uniqueIndex("sales_one_active_per_order_item_idx")
      .on(t.orderItemId)
      .where(sql`${t.voidedAt} IS NULL`),
    check(
      "sales_online_has_order",
      sql`${t.channel} <> 'ONLINE' OR ${t.orderId} IS NOT NULL`,
    ),
    check("sales_price_nonnegative", sql`${t.priceMinor} >= 0`),
    index("sales_order_idx").on(t.orderId),
  ],
);

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    // Identity. `id` is sent to the provider as ReturnValue / custom_id.
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: "restrict" }),
    seq: smallint().notNull(),
    provider: paymentProviderEnum().notNull(),
    providerMode: providerModeEnum().notNull(),
    merchantRef: text(),
    isDemo: boolean().notNull().default(false),
    status: attemptStatusEnum().notNull().default("CREATED"),

    // Quote binding (copied from the order at creation)
    quoteVersion: integer().notNull(),
    amountMinor: integer().notNull(),
    currency: currencyEnum().notNull(),

    // Provider references
    providerRef: text(),
    transactionId: text(),
    captureId: text(),
    redirectUrl: text(),

    // Idempotency
    createRequestId: uuid(),
    captureRequestId: uuid(),
    captureTries: smallint().notNull().default(0),
    capturingSince: tstz(),

    // Payment details
    method: text(),
    installments: smallint(),
    cardLast4: text(),
    cardBrand: text(),
    isForeignCard: boolean(),
    approvalCode: text(),
    failureReason: text(),
    /** Redacted, allowlisted provider payload. */
    verifiedRaw: jsonb(),

    // Polling
    nextCheckAt: tstz(),
    checkCount: integer().notNull().default(0),
    lastCheckedAt: tstz(),
    /** Cardcom: created + CARDCOM_TAIL_DAYS. */
    tailUntil: tstz(),
    finalizedAt: tstz(),

    ...timestamps,
  },
  (t) => [
    unique("payment_attempts_order_seq_uq").on(t.orderId, t.seq),
    check("payment_attempts_seq_range", sql`${t.seq} BETWEEN 1 AND 5`),
    check("payment_attempts_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "payment_attempts_counters_nonnegative",
      sql`${t.captureTries} >= 0 AND ${t.checkCount} >= 0 AND ${t.quoteVersion} >= 1`,
    ),
    check(
      "payment_attempts_mock_mode",
      sql`${t.provider} <> 'MOCK' OR ${t.providerMode} = 'MOCK'`,
    ),
    check(
      "payment_attempts_offline_mode",
      sql`${t.provider} <> 'OFFLINE' OR ${t.providerMode} = 'MANUAL'`,
    ),
    check(
      "payment_attempts_demo_not_live",
      sql`NOT ${t.isDemo} OR ${t.providerMode} <> 'LIVE'`,
    ),
    uniqueIndex("payment_attempts_provider_ref_idx")
      .on(t.provider, t.providerRef)
      .where(sql`${t.providerRef} IS NOT NULL`),
    // One winning payment per order.
    uniqueIndex("payment_attempts_one_winner_idx")
      .on(t.orderId)
      .where(sql`${t.status} IN ('CAPTURING', 'PAYMENT_REVIEW', 'SUCCEEDED')`),
    index("payment_attempts_status_next_check_idx").on(t.status, t.nextCheckAt),
  ],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: paymentProviderEnum().notNull(),
    eventKey: text().notNull(),
    eventType: text(),
    attemptId: uuid().references(() => paymentAttempts.id, {
      onDelete: "restrict",
    }),
    authenticated: boolean().notNull().default(false),
    payloadRedacted: jsonb(),
    receivedAt: tstz().notNull().defaultNow(),
    receivedCount: integer().notNull().default(1),
    /** Null until processing succeeded; the reconcile job replays unprocessed events. */
    processedAt: tstz(),
    outcome: text(),
    lastError: text(),
    ...timestamps,
  },
  (t) => [
    unique("payment_events_provider_key_uq").on(t.provider, t.eventKey),
    check("payment_events_received_count", sql`${t.receivedCount} >= 1`),
    index("payment_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
    index("payment_events_attempt_idx").on(t.attemptId),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid().primaryKey().defaultRandom(),
    attemptId: uuid()
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: "restrict" }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    cancellationId: uuid().references((): AnyPgColumn => cancellations.id, {
      onDelete: "restrict",
    }),
    amountMinor: integer().notNull(),
    currency: currencyEnum().notNull(),
    feeWithheldMinor: integer().notNull().default(0),
    reason: refundReasonEnum().notNull(),
    status: refundStatusEnum().notNull().default("REQUESTED"),
    idemKey: uuid().notNull().unique("refunds_idem_key_unique").defaultRandom(),
    providerCalls: smallint().notNull().default(0),
    inFlightUntil: tstz(),
    providerRefundId: text().unique("refunds_provider_refund_id_unique"),
    manualReference: text(),
    /** Set by an admin after checking the provider dashboard; only then a FAILED row stops counting. */
    failureConfirmedAt: tstz(),
    failureConfirmedBy: text(),
    requestedBy: text().notNull(),
    legalDueAt: tstz(),
    error: text(),
    completedAt: tstz(),
    ...timestamps,
  },
  (t) => [
    check("refunds_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "refunds_counters_nonnegative",
      sql`${t.feeWithheldMinor} >= 0 AND ${t.providerCalls} >= 0`,
    ),
    check(
      "refunds_manual_done_reference",
      sql`${t.status} <> 'MANUAL_DONE' OR ${t.manualReference} IS NOT NULL`,
    ),
    uniqueIndex("refunds_one_live_per_cancellation_idx")
      .on(t.cancellationId)
      .where(
        sql`${t.cancellationId} IS NOT NULL AND NOT (${t.status} = 'FAILED' AND ${t.failureConfirmedAt} IS NOT NULL)`,
      ),
    index("refunds_attempt_idx").on(t.attemptId),
    index("refunds_order_idx").on(t.orderId),
    index("refunds_status_idx").on(t.status),
  ],
);

/** Non-production only: the mock provider's "hosted page" state. */
export const mockPayments = pgTable(
  "mock_payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    ref: text().notNull().unique(),
    attemptId: uuid()
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: "restrict" }),
    amountMinor: integer().notNull(),
    currency: currencyEnum().notNull(),
    flow: text().$type<MockPaymentFlow>().notNull().default("DIRECT"),
    state: text().$type<MockPaymentState>().notNull().default("OPEN"),
    transactionId: text(),
    refundedMinor: integer().notNull().default(0),
    captureRequestIds: text().array().notNull().default(sql`'{}'::text[]`),
    refundRequestIds: text().array().notNull().default(sql`'{}'::text[]`),
    returnUrl: text().notNull(),
    cancelUrl: text().notNull(),
    notifyUrl: text().notNull(),
    ...timestamps,
  },
  (t) => [
    check(
      "mock_payments_flow_values",
      sql`${t.flow} IN (${sqlInList(MOCK_PAYMENT_FLOWS)})`,
    ),
    check(
      "mock_payments_state_values",
      sql`${t.state} IN (${sqlInList(MOCK_PAYMENT_STATES)})`,
    ),
    check(
      "mock_payments_amounts",
      sql`${t.amountMinor} > 0 AND ${t.refundedMinor} >= 0 AND ${t.refundedMinor} <= ${t.amountMinor}`,
    ),
    index("mock_payments_attempt_idx").on(t.attemptId),
  ],
);

export const taxDocuments = pgTable(
  "tax_documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    attemptId: uuid().references(() => paymentAttempts.id, {
      onDelete: "restrict",
    }),
    refundId: uuid().references(() => refunds.id, { onDelete: "restrict" }),
    kind: taxdocKindEnum().notNull(),
    provider: taxdocProviderEnum().notNull(),
    status: taxdocStatusEnum().notNull().default("ISSUING"),
    /** Our exactly-once marker, e.g. `GG-7K3M9Q/RECEIPT/1`; searched in Morning before re-issuing. */
    marker: text().notNull().unique(),
    providerDocId: text(),
    docNumber: text(),
    docTypeCode: integer(),
    allocationNumber: text(),
    docUrl: text(),
    fileKey: text(),
    attempts: integer().notNull().default(0),
    lastAttemptAt: tstz(),
    error: text(),
    issuedAt: tstz(),
    ...timestamps,
  },
  (t) => [
    check(
      "tax_documents_credit_note_has_refund",
      sql`${t.kind} <> 'CREDIT_NOTE' OR ${t.refundId} IS NOT NULL`,
    ),
    check(
      "tax_documents_receipt_has_attempt",
      sql`${t.kind} = 'CREDIT_NOTE' OR ${t.attemptId} IS NOT NULL`,
    ),
    check("tax_documents_attempts_nonnegative", sql`${t.attempts} >= 0`),
    uniqueIndex("tax_documents_one_receipt_per_attempt_idx")
      .on(t.attemptId)
      .where(
        sql`${t.kind} IN ('RECEIPT', 'INVOICE_RECEIPT') AND ${t.status} <> 'FAILED'`,
      ),
    uniqueIndex("tax_documents_one_credit_note_per_refund_idx")
      .on(t.refundId)
      .where(sql`${t.kind} = 'CREDIT_NOTE' AND ${t.status} <> 'FAILED'`),
    index("tax_documents_order_idx").on(t.orderId),
    index("tax_documents_status_idx").on(t.status),
  ],
);

export const generatedDocuments = pgTable(
  "generated_documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid().references(() => orders.id, { onDelete: "restrict" }),
    saleId: uuid().references(() => sales.id, { onDelete: "restrict" }),
    kind: generatedDocKindEnum().notNull(),
    locale: localeEnum().notNull(),
    version: text().notNull(),
    fileKey: text().notNull(),
    sha256: text().notNull(),
    ...timestamps,
  },
  (t) => [
    unique("generated_documents_order_kind_locale_version_uq").on(
      t.orderId,
      t.kind,
      t.locale,
      t.version,
    ),
    check(
      "generated_documents_has_owner",
      sql`${t.orderId} IS NOT NULL OR ${t.saleId} IS NOT NULL`,
    ),
    index("generated_documents_sale_idx").on(t.saleId),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type Sale = typeof sales.$inferSelect;
export type NewSale = typeof sales.$inferInsert;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type NewPaymentAttempt = typeof paymentAttempts.$inferInsert;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;
export type MockPayment = typeof mockPayments.$inferSelect;
export type TaxDocument = typeof taxDocuments.$inferSelect;
export type GeneratedDocument = typeof generatedDocuments.$inferSelect;
