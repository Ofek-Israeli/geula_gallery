import "server-only";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { artworks } from "./catalog";
import { sqlInList, timestamps, tstz } from "./columns";
import { orderItems, orders, refunds } from "./commerce";
import {
  cancellationChannelEnum,
  cancellationReasonEnum,
  cancellationRegimeEnum,
  cancellationStatusEnum,
  currencyEnum,
  eligibleGroupEnum,
  localeEnum,
  REQUEST_TOPICS,
  type RequestTopic,
  requestKindEnum,
  requestStatusEnum,
  returnStatusEnum,
} from "./enums";

export const buyerRequests = pgTable(
  "buyer_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: requestKindEnum().notNull(),
    topic: text().$type<RequestTopic>(),
    artworkId: uuid().references(() => artworks.id, { onDelete: "set null" }),
    name: text().notNull(),
    email: text().notNull(),
    phone: text(),
    country: char({ length: 2 }),
    locale: localeEnum().notNull(),
    message: text().notNull().default(""),
    offerAmountMinor: integer(),
    offerCurrency: currencyEnum(),
    status: requestStatusEnum().notNull().default("NEW"),
    orderId: uuid().references((): AnyPgColumn => orders.id, {
      onDelete: "restrict",
    }),
    adminReply: text(),
    repliedAt: tstz(),
    ipHash: text(),
    ...timestamps,
  },
  (t) => [
    check(
      "buyer_requests_topic_values",
      sql`${t.topic} IS NULL OR ${t.topic} IN (${sqlInList(REQUEST_TOPICS)})`,
    ),
    check(
      "buyer_requests_offer_amount",
      sql`${t.kind} <> 'OFFER' OR (${t.offerAmountMinor} > 0 AND ${t.offerCurrency} IS NOT NULL)`,
    ),
    uniqueIndex("buyer_requests_one_new_offer_idx")
      .on(t.artworkId, sql`lower(${t.email})`)
      .where(sql`${t.kind} = 'OFFER' AND ${t.status} = 'NEW'`),
    index("buyer_requests_email_idx").on(sql`lower(${t.email})`),
    index("buyer_requests_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * A legal cancellation notice. There is deliberately NO unique index on `order_id`: a second notice
 * (double submission, web then phone) must never fail (spec §3.3).
 *
 * Per-work cancellation: `requested_item_ids` names the works the buyer chose (null = every work of
 * the order still active). What was actually cancelled is `cancellation_items` (rows written on
 * acceptance). The refund base is `items_minor` (Σ the cancelled works' prices) plus
 * `shipping_refund_minor` (shipping and insurance, refunded only by the cancellation that leaves no
 * active work — at most one per order).
 */
export const cancellations = pgTable(
  "cancellations",
  {
    // Request
    id: uuid().primaryKey().defaultRandom(),
    /** `C-` + 6 Crockford base32 characters. */
    number: text().notNull().unique(),
    orderId: uuid().references((): AnyPgColumn => orders.id, {
      onDelete: "restrict",
    }),
    regime: cancellationRegimeEnum().notNull().default("IL"),
    status: cancellationStatusEnum().notNull().default("RECEIVED"),
    returnStatus: returnStatusEnum().notNull().default("NOT_APPLICABLE"),
    channel: cancellationChannelEnum().notNull().default("WEB"),
    reason: cancellationReasonEnum(),
    fullName: text().notNull(),
    /** AES-256-GCM ciphertext; the ID is masked everywhere else. */
    idNumberEnc: text(),
    idNumberLast3: text(),
    orderNumberInput: text(),
    email: text(),
    phone: text(),
    message: text(),
    eligibleGroup: eligibleGroupEnum().notNull().default("NONE"),
    /** `order_items.id`s the buyer named; null = the whole order. */
    requestedItemIds: uuid().array(),

    // Duplicates
    duplicateOfId: uuid().references((): AnyPgColumn => cancellations.id, {
      onDelete: "restrict",
    }),
    possibleDuplicate: boolean().notNull().default(false),

    // Timing
    /** The legal notice time. */
    receivedAt: tstz().notNull().defaultNow(),
    ackSentAt: tstz(),
    /** Acknowledgement content (ID masked), date and time. */
    ackSnapshot: jsonb(),

    // Assessment
    windowEndsAt: tstz(),
    withinWindow: boolean(),
    feeMinor: integer(),
    refundAmountMinor: integer(),
    /** Σ of the cancelled works' prices (order currency). */
    itemsMinor: integer(),
    /** Shipping + insurance refunded: only by the cancellation that leaves no active work. */
    shippingRefundMinor: integer().notNull().default(0),
    refundId: uuid().references((): AnyPgColumn => refunds.id, {
      onDelete: "restrict",
    }),
    /** = received_at + 14 days. */
    refundDueAt: tstz(),

    // Return and decision
    returnTracking: text(),
    returnReceivedAt: tstz(),
    inspectionNotes: text(),
    decisionReason: text(),
    decidedBy: text(),
    decidedAt: tstz(),
    closedAt: tstz(),

    ...timestamps,
  },
  (t) => [
    check(
      "cancellations_identifier_present",
      sql`${t.idNumberEnc} IS NOT NULL OR ${t.orderNumberInput} IS NOT NULL OR ${t.orderId} IS NOT NULL`,
    ),
    check(
      "cancellations_rejected_has_reason",
      sql`${t.status} <> 'REJECTED' OR ${t.decisionReason} IS NOT NULL`,
    ),
    check(
      "cancellations_amounts_nonnegative",
      sql`(${t.feeMinor} IS NULL OR ${t.feeMinor} >= 0) AND (${t.refundAmountMinor} IS NULL OR ${t.refundAmountMinor} >= 0)`,
    ),
    check(
      "cancellations_item_amounts_nonnegative",
      sql`(${t.itemsMinor} IS NULL OR ${t.itemsMinor} >= 0) AND ${t.shippingRefundMinor} >= 0`,
    ),
    check(
      "cancellations_refund_within_base",
      sql`${t.refundAmountMinor} IS NULL OR ${t.itemsMinor} IS NULL OR ${t.refundAmountMinor} + coalesce(${t.feeMinor}, 0) <= ${t.itemsMinor} + ${t.shippingRefundMinor}`,
    ),
    check(
      "cancellations_id_last3_format",
      sql`${t.idNumberLast3} IS NULL OR ${t.idNumberLast3} ~ '^[0-9A-Za-z]{1,3}$'`,
    ),
    check(
      "cancellations_not_self_duplicate",
      sql`${t.duplicateOfId} IS NULL OR ${t.duplicateOfId} <> ${t.id}`,
    ),
    unique("cancellations_id_order_uq").on(t.id, t.orderId),
    // Shipping is refunded once per order (by the cancellation that leaves no active work).
    uniqueIndex("cancellations_one_shipping_refund_idx")
      .on(t.orderId)
      .where(
        sql`${t.shippingRefundMinor} > 0 AND ${t.status} IN ('ACCEPTED', 'CLOSED')`,
      ),
    index("cancellations_order_idx").on(t.orderId),
    index("cancellations_status_due_idx").on(t.status, t.refundDueAt),
  ],
);

/**
 * The works an accepted cancellation covers (one row per order item, written on acceptance). The
 * primary key on `order_item_id` is what stops a work from being cancelled twice; the composite
 * foreign keys keep the item inside the notice's order. `return_status` follows each work's return
 * and inspection (a damaged work is relisted as NOT_FOR_SALE, the others as AVAILABLE).
 */
export const cancellationItems = pgTable(
  "cancellation_items",
  {
    orderItemId: uuid().primaryKey(),
    cancellationId: uuid().notNull(),
    orderId: uuid().notNull(),
    returnStatus: returnStatusEnum().notNull().default("NOT_APPLICABLE"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "cancellation_items_cancellation_fk",
      columns: [t.cancellationId, t.orderId],
      foreignColumns: [cancellations.id, cancellations.orderId],
    }).onDelete("restrict"),
    foreignKey({
      name: "cancellation_items_order_item_fk",
      columns: [t.orderItemId, t.orderId],
      foreignColumns: [orderItems.id, orderItems.orderId],
    }).onDelete("restrict"),
    index("cancellation_items_cancellation_idx").on(t.cancellationId),
    index("cancellation_items_order_idx").on(t.orderId),
  ],
);

export type BuyerRequest = typeof buyerRequests.$inferSelect;
export type NewBuyerRequest = typeof buyerRequests.$inferInsert;
export type Cancellation = typeof cancellations.$inferSelect;
export type NewCancellation = typeof cancellations.$inferInsert;
export type CancellationItem = typeof cancellationItems.$inferSelect;
