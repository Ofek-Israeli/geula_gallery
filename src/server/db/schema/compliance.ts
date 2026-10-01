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
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { artworks } from "./catalog";
import { sqlInList, timestamps, tstz } from "./columns";
import { orders, refunds } from "./commerce";
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
      "cancellations_id_last3_format",
      sql`${t.idNumberLast3} IS NULL OR ${t.idNumberLast3} ~ '^[0-9A-Za-z]{1,3}$'`,
    ),
    check(
      "cancellations_not_self_duplicate",
      sql`${t.duplicateOfId} IS NULL OR ${t.duplicateOfId} <> ${t.id}`,
    ),
    index("cancellations_order_idx").on(t.orderId),
    index("cancellations_status_due_idx").on(t.status, t.refundDueAt),
  ],
);

export type BuyerRequest = typeof buyerRequests.$inferSelect;
export type NewBuyerRequest = typeof buyerRequests.$inferInsert;
export type Cancellation = typeof cancellations.$inferSelect;
export type NewCancellation = typeof cancellations.$inferInsert;
