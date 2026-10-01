import "server-only";
import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps, tstz } from "./columns";
import { orders } from "./commerce";
import {
  carrierEnum,
  currencyEnum,
  eventSourceEnum,
  exportDeclStatusEnum,
  shipmentStatusEnum,
  shippingMethodEnum,
} from "./enums";

/** One per order. */
export const shipments = pgTable(
  "shipments",
  {
    // Core
    id: uuid().primaryKey().defaultRandom(),
    orderId: uuid()
      .notNull()
      .unique("shipments_order_id_unique")
      .references(() => orders.id, { onDelete: "restrict" }),
    status: shipmentStatusEnum().notNull().default("AWAITING_FULFILLMENT"),
    method: shippingMethodEnum().notNull(),
    /** Null for local pickup and artist delivery. */
    carrier: carrierEnum(),
    carrierName: text(),
    serviceCode: text(),
    adapterMode: text(),
    trackingNumber: text(),
    trackingUrl: text(),
    packages: jsonb().notNull().default([]),

    // Declared value and insurance
    declaredValueMinor: integer(),
    declaredCurrency: currencyEnum(),
    /** The capped insured value. */
    insuredValueMinor: integer(),
    insuranceProvider: text(),
    insurancePremiumMinor: integer(),

    // Customs
    hsCode: text(),
    originCountry: char({ length: 2 }),
    contentsDescriptionEn: text(),
    reasonForExport: text(),
    incoterm: text(),
    commercialInvoiceNumber: text(),
    exportDeclarationNumber: text(),
    exportDeclStatus: exportDeclStatusEnum().notNull().default("NOT_REQUIRED"),

    // Files and checklist
    labelFileKey: text(),
    invoiceFileKey: text(),
    packingPhotoKeys: text().array().notNull().default(sql`'{}'::text[]`),
    checklist: jsonb().notNull().default({}),

    // Carrier interaction (claim protocol)
    pickupConfirmation: text(),
    costActualMinor: integer(),
    chargedToBuyerMinor: integer(),
    idempotencyKey: uuid().unique("shipments_idempotency_key_unique"),
    labelAttempt: integer().notNull().default(0),
    messageReference: text(),
    providerShipmentId: text(),
    providerResponseRedacted: jsonb(),
    cancellationOverrideReason: text(),

    // Timestamps
    shippedAt: tstz(),
    estimatedDeliveryAt: tstz(),
    deliveredAt: tstz(),
    lastTrackedAt: tstz(),
    insuranceClaimDeadlineAt: tstz(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("shipments_carrier_tracking_idx")
      .on(t.carrier, t.trackingNumber)
      .where(sql`${t.trackingNumber} IS NOT NULL`),
    check(
      "shipments_amounts_nonnegative",
      sql`(${t.declaredValueMinor} IS NULL OR ${t.declaredValueMinor} >= 0) AND (${t.insuredValueMinor} IS NULL OR ${t.insuredValueMinor} >= 0) AND (${t.insurancePremiumMinor} IS NULL OR ${t.insurancePremiumMinor} >= 0) AND (${t.costActualMinor} IS NULL OR ${t.costActualMinor} >= 0) AND (${t.chargedToBuyerMinor} IS NULL OR ${t.chargedToBuyerMinor} >= 0) AND ${t.labelAttempt} >= 0`,
    ),
    index("shipments_status_idx").on(t.status),
  ],
);

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    shipmentId: uuid()
      .notNull()
      .references(() => shipments.id, { onDelete: "restrict" }),
    occurredAt: tstz().notNull(),
    status: shipmentStatusEnum(),
    /** Carrier event code; '' for manual events without one (part of the dedupe key). */
    code: text().notNull().default(""),
    description: text(),
    location: text(),
    source: eventSourceEnum().notNull(),
    raw: jsonb(),
    ...timestamps,
  },
  (t) => [
    unique("shipment_events_dedupe_uq").on(
      t.shipmentId,
      t.source,
      t.occurredAt,
      t.code,
    ),
  ],
);

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;
