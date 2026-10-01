import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { formatDimensions } from "@/lib/dimensions";
import type { Locale } from "@/lib/locale";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  cancellations,
  type Order,
  orderItems,
  orders,
  type Shipment,
  type ShipmentEvent,
  shipmentEvents,
  shipments,
} from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { env as defaultEnv, type Env } from "@/server/env";
import { orderAccessToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import {
  storage as defaultStorage,
  type StorageAdapter,
} from "@/server/storage";
import { type ChecklistEntry, checklistFor, photosRequired } from "./checklist";
import { customsDescriptionEn, declaredValueUsdMinor } from "./customs";
import { packedBox } from "./rates";
import { carrierFor } from "./registry";
import {
  type FulfillmentBlock,
  fulfillmentBlock,
  STALE_LABEL_REQUEST_MS,
} from "./shipments";
import type {
  ArtworkShipSpec,
  CarrierCode,
  PackagingType,
  ShipmentPackage,
} from "./types";

/**
 * Read model of `/admin/orders/[id]/fulfill` (spec §5.5, §6.10). Admin only (`AdminContext`):
 * it contains the buyer's address. Private files (label, carrier invoice, packing photos) are
 * offered only as signed URLs that expire after 10 minutes (spec §4.6).
 */
export const SIGNED_URL_TTL_SEC = 600;

export interface FulfillmentItem {
  title: string;
  inventoryNumber: string;
  dimensionsText: string;
  packagingType: PackagingType;
  canBeRolled: boolean;
  coaIncluded: boolean;
  suggested: ShipmentPackage;
}

export interface FulfillmentView {
  order: Pick<
    Order,
    | "id"
    | "number"
    | "status"
    | "locale"
    | "currency"
    | "shipCountry"
    | "shippingMethod"
    | "buyerName"
    | "buyerEmail"
    | "buyerPhone"
    | "receiptEmailConsent"
    | "disclosureSentAt"
    | "disclosureHandedOverAt"
    | "fulfillmentBlockedReason"
    | "itemsTotalMinor"
    | "deliveredAt"
  >;
  international: boolean;
  addressLines: string[];
  buyerToken: string;
  items: FulfillmentItem[];
  shipment: Shipment;
  events: ShipmentEvent[];
  cancellations: { number: string; status: string; receivedAt: Date }[];
  block: FulfillmentBlock | null;
  checklist: (ChecklistEntry & { checked: boolean })[];
  photosRequired: boolean;
  photos: { key: string; url: string }[];
  labelUrl: string | null;
  invoiceUrl: string | null;
  defaults: {
    packages: ShipmentPackage[];
    customsDescription: string;
    declaredValueMinor: number;
    insuredValueMinor: number;
  };
  exportThresholdUsd: number;
  exportRequiredByValue: boolean;
  insuranceCapIls: number;
  labelCarrier: CarrierCode | null;
  staleLabelRequest: boolean;
  pickupAddress: string;
}

function suggestedPackage(a: ArtworkShipSpec): ShipmentPackage {
  const box = packedBox(a);
  return {
    lengthMm: box.lengthMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    weightG: a.packedWeightG,
  };
}

export async function getFulfillment(
  _ctx: AdminContext,
  orderId: string,
  locale: Locale,
  deps: { db?: DbOrTx; env?: Env; storage?: StorageAdapter; now?: Date } = {},
): Promise<FulfillmentView | null> {
  const db = deps.db ?? defaultDb;
  const env = deps.env ?? defaultEnv;
  const store = deps.storage ?? defaultStorage();
  const now = deps.now ?? new Date();
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, order.id));
  if (!shipment) return null;

  const [rows, events, notices, profile, shipping, checkout] =
    await Promise.all([
      db
        .select({ item: orderItems, art: artworks })
        .from(orderItems)
        .innerJoin(artworks, eq(artworks.id, orderItems.artworkId))
        .where(eq(orderItems.orderId, order.id))
        .orderBy(asc(orderItems.createdAt)),
      db
        .select()
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipment.id))
        .orderBy(
          desc(shipmentEvents.occurredAt),
          desc(shipmentEvents.createdAt),
        ),
      db
        .select({
          number: cancellations.number,
          status: cancellations.status,
          receivedAt: cancellations.receivedAt,
        })
        .from(cancellations)
        .where(
          and(
            eq(cancellations.orderId, order.id),
            inArray(cancellations.status, ["RECEIVED", "ACCEPTED"]),
          ),
        ),
      getSetting("business_profile", db),
      getSetting("shipping", db),
      getSetting("checkout", db),
    ]);

  const specs = rows.map(
    ({ art: a }): ArtworkShipSpec => ({
      artworkId: a.id,
      heightMm: a.heightMm,
      widthMm: a.widthMm,
      depthMm: a.depthMm,
      packagingType: a.packagingType as PackagingType,
      canBeRolled: a.canBeRolled,
      packedLengthMm: a.packedLengthMm ?? a.heightMm + 120,
      packedWidthMm: a.packedWidthMm ?? a.widthMm + 120,
      packedHeightMm: a.packedHeightMm ?? (a.depthMm ?? 20) + 80,
      packedWeightG: a.packedWeightG ?? 2000,
      sizeClassOverride: null,
      glazing: a.glazing,
      framed: a.framed,
      shipsInternationally: a.shipsInternationally,
      localPickupOnly: a.localPickupOnly,
      quoteOnly: a.quoteOnly,
      maxInsurableValueMinor: a.maxInsurableValueMinor,
      dispatchDays: a.dispatchDays,
    }),
  );
  const items: FulfillmentItem[] = rows.map(({ item, art: a }, i) => ({
    title: locale === "he" ? item.titleHe : item.titleEn,
    inventoryNumber: a.inventoryNumber,
    dimensionsText: (() => {
      const d = formatDimensions(
        { heightMm: a.heightMm, widthMm: a.widthMm, depthMm: a.depthMm },
        locale,
      );
      return `${d.cm} (${d.inches})`;
    })(),
    packagingType: a.packagingType as PackagingType,
    canBeRolled: a.canBeRolled,
    coaIncluded: a.coaIncluded,
    suggested: suggestedPackage(specs[i] as ArtworkShipSpec),
  }));

  const statuses = notices.map((n) => n.status);
  const block = fulfillmentBlock(order, shipment, statuses);
  const saved = ((
    shipment.checklist as { items?: Record<string, boolean> } | null
  )?.items ?? {}) as Record<string, boolean>;
  const checklist = checklistFor({
    packagingTypes: items.map((i) => i.packagingType),
    coaIncluded: items.some((i) => i.coaIncluded),
    receiptEmailConsent: order.receiptEmailConsent ?? false,
  }).map((e) => ({ ...e, checked: saved[e.item] === true }));

  const international = order.shipCountry !== "IL";
  const sign = (key: string | null) =>
    key ? store.signedPrivateUrl(key, SIGNED_URL_TTL_SEC) : null;
  const first = rows[0]?.art;
  const mediumEn = first
    ? first.mediumDetailEn?.trim() ||
      `${first.medium.toLowerCase().replace(/_/g, " ")} on ${first.surface.toLowerCase().replace(/_/g, " ")}`
    : "";
  let labelCarrier: CarrierCode | null = null;
  if (shipment.carrier === "MOCK" || shipment.carrier === "DHL") {
    labelCarrier = shipment.carrier;
  } else if (shipment.method === "QUOTED" && international) {
    const c = carrierFor(order.shipCountry, { env });
    labelCarrier = c === "MANUAL" ? null : c;
  }
  const declaredUsd = declaredValueUsdMinor(
    shipment.declaredValueMinor ?? order.itemsTotalMinor,
    shipment.declaredCurrency ?? order.currency,
    checkout.fx.ilsPerUsd,
  );

  return {
    order,
    international,
    addressLines: [
      order.shipName,
      order.shipLine1,
      order.shipLine2,
      [order.shipPostalCode, order.shipCity].filter(Boolean).join(" "),
      order.shipRegion,
      order.shipCountry,
      order.shipPhone,
    ].filter((l): l is string => !!l),
    buyerToken: orderAccessToken(order.id, order.accessVersion),
    items,
    shipment,
    events,
    cancellations: notices,
    block,
    checklist,
    photosRequired: photosRequired({
      international,
      insured: (shipment.insuredValueMinor ?? 0) > 0,
    }),
    photos: shipment.packingPhotoKeys.map((key) => ({
      key,
      url: sign(key) as string,
    })),
    labelUrl: sign(shipment.labelFileKey),
    invoiceUrl: sign(shipment.invoiceFileKey),
    defaults: {
      packages: (shipment.packages as ShipmentPackage[] | null)?.length
        ? (shipment.packages as ShipmentPackage[])
        : items.map((i) => i.suggested),
      customsDescription:
        shipment.contentsDescriptionEn ??
        customsDescriptionEn({
          mediumText: mediumEn,
          yearCreated: first?.yearCreated ?? null,
          artistName: profile.artistName.en,
        }),
      declaredValueMinor: shipment.declaredValueMinor ?? order.itemsTotalMinor,
      insuredValueMinor: shipment.insuredValueMinor ?? 0,
    },
    exportThresholdUsd: shipping.thresholds.exportDeclarationUsd,
    exportRequiredByValue:
      declaredUsd > Math.round(shipping.thresholds.exportDeclarationUsd * 100),
    insuranceCapIls: shipping.insurance.maxInsuredIls,
    labelCarrier,
    staleLabelRequest:
      shipment.status === "LABEL_REQUESTED" &&
      now.getTime() - shipment.updatedAt.getTime() >= STALE_LABEL_REQUEST_MS,
    pickupAddress: profile.pickupAddress[locale],
  };
}
