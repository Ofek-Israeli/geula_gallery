import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { jerusalemDateKey } from "@/lib/format";
import { usdToIls } from "@/lib/money";
import type { PostalAddress } from "@/lib/validation/address";
import { raiseAlert } from "@/server/alerts/service";
import { audit, auditBy } from "@/server/audit";
import { type Db, type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  cancellations,
  type Order,
  orderItems,
  orders,
  type Shipment,
  shipmentEvents,
  shipments,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  ValidationError,
} from "@/server/domain/errors";
import { commercialInvoiceNumber } from "@/server/domain/ids";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  isProviderError,
  ProviderNotConfiguredError,
} from "@/server/integrations/http";
import { log } from "@/server/log";
import { getSetting } from "@/server/settings";
import type { BusinessProfile } from "@/server/settings/schemas";
import {
  storage as defaultStorage,
  type StorageAdapter,
} from "@/server/storage";
import {
  checklistFor,
  MAX_PACKING_PHOTOS,
  missingRequired,
  PACKING_PHOTO_KEY,
  photosRequired,
} from "./checklist";
import {
  contentsDescriptionShort,
  customsDescriptionEn,
  declaredLineValues,
  declaredValueUsdMinor,
  EXPORT_COMMODITY_CODE,
  exportDeclarationRequired,
  HS_CODE,
  importCommodityCode,
} from "./customs";
import { insuredValueInCurrency } from "./rates";
import { carrierAdapter, carrierFor } from "./registry";
import { applyShipmentStatus, lockShipmentOf } from "./status";
import type {
  CarrierAdapter,
  CarrierCode,
  CreateShipmentRequest,
  PackagingType,
  ShipmentPackage,
  ShipmentParty,
  ShippingQuoteResult,
} from "./types";

/**
 * Fulfillment services (spec §5.5). Every mutation locks order → shipment, re-checks the guards
 * inside the transaction and changes status through `applyShipmentStatus` (event row, buyer
 * email, delivery bookkeeping). Frozen entry points: `createShipmentForOrder`, `requestLabel`,
 * `recordManualTracking`.
 *
 * Guards (spec §5.5): the order is PAID; no `fulfillment_blocked_reason` other than a pending
 * cancellation; no ACCEPTED cancellation; a RECEIVED cancellation (or the PENDING_CANCELLATION
 * block) stops fulfillment unless the admin overrides it with a reason (audited).
 *
 * The label claim protocol (no idempotency key and no cancel at DHL): PACKED → LABEL_REQUESTED
 * (`label_attempt+1`, `idempotency_key` derived from `<orderId>:<n>`, a new `message_reference`)
 * is committed before the carrier call; success → LABEL_CREATED (files private); a clear refusal
 * → PACKED; a timeout or any unknowable outcome → LABEL_UNKNOWN + alert, and the admin either
 * records the label found in MyDHL or confirms that none exists before buying again.
 */

export interface ShipmentDeps {
  db?: Db;
  env?: Env;
  /** Injected in tests; defaults to the registry adapter for the shipment's carrier. */
  carrier?: CarrierAdapter;
  storage?: StorageAdapter;
  now?: () => Date;
}

// ---------------------------------------------------------------- guards

export type FulfillmentBlock =
  | { code: "ORDER_NOT_PAID" }
  | { code: "FULFILLMENT_BLOCKED"; reason: string }
  | { code: "CANCELLATION_ACCEPTED" }
  | { code: "CANCELLATION_PENDING"; overridable: true };

/** Pure: why fulfillment is refused, or null. */
export function fulfillmentBlock(
  order: Pick<Order, "status" | "fulfillmentBlockedReason">,
  shipment: Pick<Shipment, "cancellationOverrideReason"> | null,
  cancellationStatuses: readonly string[],
): FulfillmentBlock | null {
  if (order.status !== "PAID") return { code: "ORDER_NOT_PAID" };
  if (cancellationStatuses.includes("ACCEPTED")) {
    return { code: "CANCELLATION_ACCEPTED" };
  }
  const blocked = order.fulfillmentBlockedReason;
  if (blocked && blocked !== "PENDING_CANCELLATION") {
    return { code: "FULFILLMENT_BLOCKED", reason: blocked };
  }
  const pending =
    blocked === "PENDING_CANCELLATION" ||
    cancellationStatuses.includes("RECEIVED");
  if (pending && !shipment?.cancellationOverrideReason) {
    return { code: "CANCELLATION_PENDING", overridable: true };
  }
  return null;
}

export class FulfillmentBlockedError extends ConflictError {
  constructor(public readonly block: FulfillmentBlock) {
    super(
      block.code === "ORDER_NOT_PAID"
        ? "ORDER_NOT_PAID"
        : "FULFILLMENT_BLOCKED",
      `fulfillment refused: ${block.code}${"reason" in block ? ` (${block.reason})` : ""}`,
      { block: block.code },
    );
    this.name = "FulfillmentBlockedError";
  }
}

async function openCancellationStatuses(
  db: DbOrTx,
  orderId: string,
): Promise<string[]> {
  const rows = await db
    .select({ status: cancellations.status })
    .from(cancellations)
    .where(
      and(
        eq(cancellations.orderId, orderId),
        inArray(cancellations.status, ["RECEIVED", "ACCEPTED"]),
      ),
    );
  return rows.map((r) => r.status);
}

interface Locked {
  order: Order;
  shipment: Shipment;
}

/** Locks order → shipment and applies the guards (unless `guard: false`). */
async function lockForFulfillment(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  orderId: string,
  opts: { guard?: boolean } = {},
): Promise<Locked> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update");
  if (!order) throw new NotFoundError("order", orderId);
  if (opts.guard !== false && order.status !== "PAID") {
    throw new FulfillmentBlockedError({ code: "ORDER_NOT_PAID" });
  }
  const shipment = await lockShipmentOf(tx, order.id);
  if (!shipment) throw new NotFoundError("shipment", order.id);
  if (opts.guard !== false) {
    const block = fulfillmentBlock(
      order,
      shipment,
      await openCancellationStatuses(tx, order.id),
    );
    if (block) throw new FulfillmentBlockedError(block);
  }
  return { order, shipment };
}

function requireStatus(
  shipment: Shipment,
  allowed: readonly ShipmentStatus[],
): void {
  if (!allowed.includes(shipment.status)) {
    throw new ConflictError(
      "SHIPMENT_STATE",
      `not allowed in ${shipment.status}`,
      { status: shipment.status },
    );
  }
}

function isCarrierMethod(s: Pick<Shipment, "method">): boolean {
  return s.method === "CARRIER_TABLE" || s.method === "QUOTED";
}

const done = <T>(result: T, outbox = true) =>
  withEffects(result, { outbox, revalidate: true });

// ---------------------------------------------------------------- shipment row

/**
 * Ensures the order's shipment row exists (spec §5.2 creates it when the payment is applied; this
 * covers PAID orders that reached PAID another way). Idempotent.
 */
export async function createShipmentForOrder(
  orderId: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ shipmentId: string }>> {
  const db = deps.db ?? defaultDb;
  const id = await withTx(
    async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for("update");
      if (!order) throw new NotFoundError("order", orderId);
      if (order.status !== "PAID" && order.status !== "COMPLETED") {
        throw new ConflictError("ORDER_NOT_PAID", "the order is not paid");
      }
      const existing = await lockShipmentOf(tx, order.id);
      if (existing) return existing.id;
      const quote = (order.shippingQuote ?? null) as ShippingQuoteResult | null;
      const international = order.shipCountry !== "IL";
      let exportDecl: "NOT_REQUIRED" | "REQUIRED" = "NOT_REQUIRED";
      if (international) {
        const [shipping, checkout] = await Promise.all([
          getSetting("shipping", tx),
          getSetting("checkout", tx),
        ]);
        const usd = declaredValueUsdMinor(
          order.itemsTotalMinor,
          order.currency,
          checkout.fx.ilsPerUsd,
        );
        if (
          exportDeclarationRequired(
            usd,
            shipping.thresholds.exportDeclarationUsd,
          )
        ) {
          exportDecl = "REQUIRED";
        }
      }
      const [row] = await tx
        .insert(shipments)
        .values({
          orderId: order.id,
          method: order.shippingMethod,
          carrier: quote?.carrier ?? null,
          declaredValueMinor: order.itemsTotalMinor,
          declaredCurrency: order.currency,
          insuredValueMinor: quote?.insured ? quote.insuredValueMinor : null,
          insurancePremiumMinor: quote?.insured ? order.insuranceMinor : null,
          hsCode: HS_CODE,
          originCountry: "IL",
          ...(international
            ? {
                incoterm: "DAP",
                reasonForExport: "permanent",
                commercialInvoiceNumber: commercialInvoiceNumber(order.number),
              }
            : {}),
          exportDeclStatus: exportDecl,
          chargedToBuyerMinor: order.shippingMinor + order.insuranceMinor,
        })
        .onConflictDoNothing({ target: shipments.orderId })
        .returning({ id: shipments.id });
      if (row) {
        await audit(
          {
            ...auditBy(ctx),
            action: "shipment.created",
            entity: "shipment",
            entityId: row.id,
          },
          tx,
        );
        return row.id;
      }
      const again = await lockShipmentOf(tx, order.id);
      if (!again) throw new NotFoundError("shipment", order.id);
      return again.id;
    },
    { db, name: "shipment.create" },
  );
  return done({ shipmentId: id }, false);
}

// ---------------------------------------------------------------- cancellation override

/**
 * "A cancellation notice is pending; shipping now may still require a refund" (spec §5.5): the
 * admin overrides the RECEIVED-cancellation block with a reason. Audited. Never overrides an
 * ACCEPTED cancellation or any other block.
 */
export async function overrideCancellationBlock(
  orderId: string,
  reason: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ overridden: true }>> {
  const text = reason.trim();
  if (text.length < 5) {
    throw new ValidationError(
      "REASON_REQUIRED",
      "an override reason is required",
    );
  }
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId, {
        guard: false,
      });
      const block = fulfillmentBlock(
        order,
        { cancellationOverrideReason: null },
        await openCancellationStatuses(tx, order.id),
      );
      if (block?.code !== "CANCELLATION_PENDING") {
        throw new ConflictError(
          "NOTHING_TO_OVERRIDE",
          "only a pending cancellation notice can be overridden",
        );
      }
      await tx
        .update(shipments)
        .set({ cancellationOverrideReason: text })
        .where(eq(shipments.id, shipment.id));
      await audit(
        {
          ...auditBy(ctx),
          action: "shipment.cancellation_override",
          entity: "shipment",
          entityId: shipment.id,
          after: { reason: text },
        },
        tx,
      );
    },
    { db: deps.db, name: "shipment.cancellation_override" },
  );
  return done({ overridden: true as const }, false);
}

// ---------------------------------------------------------------- pack

export interface PackingInput {
  /** Ticked checklist items. */
  checklist: readonly string[];
  packages: ShipmentPackage[];
  photoKeys: readonly string[];
}

/**
 * Step 1 "Pack" (spec §5.5): the checklist for the parcel's packaging types (the printed
 * disclosure is required; a printed receipt too without email consent), the confirmed packed
 * dimensions and weight, and packing photos (keys from `purpose=packing` uploads; at least one
 * for international or insured parcels). AWAITING_FULFILLMENT → PACKED; may be re-saved while
 * PACKED. Pickup orders are not packed (they go straight to READY_FOR_PICKUP).
 */
export async function savePacking(
  orderId: string,
  input: PackingInput,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  if (input.packages.length === 0) {
    throw new ValidationError("PACKAGES_REQUIRED", "at least one package");
  }
  for (const p of input.packages) {
    if (
      ![p.lengthMm, p.widthMm, p.heightMm, p.weightG].every(
        (n) => Number.isInteger(n) && n > 0,
      )
    ) {
      throw new ValidationError("PACKAGE_INVALID", "positive mm and g");
    }
  }
  const photos = [...new Set(input.photoKeys)];
  if (photos.length > MAX_PACKING_PHOTOS) {
    throw new ValidationError("TOO_MANY_PHOTOS", "too many packing photos");
  }
  if (photos.some((k) => !PACKING_PHOTO_KEY.test(k))) {
    throw new ValidationError("PHOTO_KEY_INVALID", "not a packing upload key");
  }

  const status = await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      if (shipment.method === "LOCAL_PICKUP") {
        throw new ConflictError(
          "PICKUP_NOT_PACKED",
          "pickup orders are not packed",
        );
      }
      requireStatus(shipment, ["AWAITING_FULFILLMENT", "PACKED"]);
      const works = await tx
        .select({
          packagingType: artworks.packagingType,
          coaIncluded: artworks.coaIncluded,
        })
        .from(orderItems)
        .innerJoin(artworks, eq(artworks.id, orderItems.artworkId))
        .where(eq(orderItems.orderId, order.id));
      const entries = checklistFor({
        packagingTypes: works.map((w) => w.packagingType as PackagingType),
        coaIncluded: works.some((w) => w.coaIncluded),
        receiptEmailConsent: order.receiptEmailConsent ?? false,
      });
      const ticked = new Set(input.checklist);
      const missing = missingRequired(entries, ticked);
      if (missing.length > 0) {
        throw new ValidationError(
          "CHECKLIST_INCOMPLETE",
          `required checklist items: ${missing.join(", ")}`,
          { missing },
        );
      }
      const international = order.shipCountry !== "IL";
      const insured = (shipment.insuredValueMinor ?? 0) > 0;
      if (photosRequired({ international, insured }) && photos.length === 0) {
        throw new ValidationError(
          "PHOTOS_REQUIRED",
          "a packing photo is required for international or insured parcels",
        );
      }
      const patch = {
        packages: input.packages,
        packingPhotoKeys: photos,
        checklist: {
          items: Object.fromEntries(
            entries.map((e) => [e.item, ticked.has(e.item)]),
          ),
          savedAt: new Date().toISOString(),
          savedBy: ctx.actor,
        },
      };
      if (shipment.status === "PACKED") {
        await tx
          .update(shipments)
          .set(patch)
          .where(eq(shipments.id, shipment.id));
        await audit(
          {
            ...auditBy(ctx),
            action: "shipment.packing_updated",
            entity: "shipment",
            entityId: shipment.id,
            after: { packages: input.packages, photos: photos.length },
          },
          tx,
        );
        return "PACKED" as const;
      }
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["AWAITING_FULFILLMENT"],
        to: "PACKED",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
        patch,
      });
      return "PACKED" as const;
    },
    { db: deps.db, name: "shipment.pack" },
  );
  return done({ status }, false);
}

// ---------------------------------------------------------------- customs

export interface CustomsInput {
  hsCode: string;
  contentsDescriptionEn: string;
  /** In the shipment's declared currency (the order currency). */
  declaredValueMinor: number;
  /** ILS minor units (the capped insured value of the quote); 0 = uninsured. */
  insuredValueMinor: number;
  /** For a REQUIRED declaration: recorded with its number, or filed by the carrier. */
  exportDeclaration?:
    | { status: "RECORDED"; number: string }
    | {
        status: "PENDING_CARRIER";
      };
}

const LATIN_TEXT = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u;

/**
 * Step 2 "Customs" (spec §5.5, international only): HS code, English description, declared and
 * insured value; a REQUIRED export declaration becomes RECORDED (with its number) or
 * PENDING_CARRIER. The commercial invoice (`CI-<orderNumber>`) is the printable page.
 */
export async function saveCustoms(
  orderId: string,
  input: CustomsInput,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ exportDeclStatus: string }>> {
  const description = input.contentsDescriptionEn.trim();
  if (!/^\d{4}\.\d{2}(\.?\d{2,4})?$/.test(input.hsCode.trim())) {
    throw new ValidationError("HS_CODE_INVALID", "HS code like 9701.91");
  }
  if (!description || !LATIN_TEXT.test(description)) {
    throw new ValidationError(
      "DESCRIPTION_LATIN",
      "the customs description must be English (Latin script)",
    );
  }
  if (
    !Number.isInteger(input.declaredValueMinor) ||
    input.declaredValueMinor <= 0
  ) {
    throw new ValidationError("DECLARED_VALUE_INVALID", "declared value > 0");
  }
  if (
    !Number.isInteger(input.insuredValueMinor) ||
    input.insuredValueMinor < 0
  ) {
    throw new ValidationError("INSURED_VALUE_INVALID", "insured value ≥ 0");
  }
  const result = await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      if (order.shipCountry === "IL") {
        throw new ConflictError(
          "NOT_INTERNATIONAL",
          "customs are for international parcels",
        );
      }
      requireStatus(shipment, ["AWAITING_FULFILLMENT", "PACKED"]);
      const shipping = await getSetting("shipping", tx);
      const cap = Math.round(shipping.insurance.maxInsuredIls * 100);
      if (input.insuredValueMinor > cap) {
        throw new ValidationError(
          "INSURED_VALUE_CAP",
          "insured value above the insurance cap",
          { capMinor: cap },
        );
      }
      let exportDeclStatus = shipment.exportDeclStatus;
      let exportDeclarationNumber = shipment.exportDeclarationNumber;
      if (exportDeclStatus !== "NOT_REQUIRED") {
        const d = input.exportDeclaration;
        if (d?.status === "RECORDED") {
          const number = d.number.trim();
          if (!/^[A-Za-z0-9/-]{4,40}$/.test(number)) {
            throw new ValidationError(
              "EXPORT_DECLARATION_NUMBER",
              "export declaration number required",
            );
          }
          exportDeclStatus = "RECORDED";
          exportDeclarationNumber = number;
        } else if (d?.status === "PENDING_CARRIER") {
          exportDeclStatus = "PENDING_CARRIER";
          exportDeclarationNumber = null;
        }
      }
      await tx
        .update(shipments)
        .set({
          hsCode: input.hsCode.trim(),
          contentsDescriptionEn: description,
          declaredValueMinor: input.declaredValueMinor,
          insuredValueMinor: input.insuredValueMinor || null,
          exportDeclStatus,
          exportDeclarationNumber,
          commercialInvoiceNumber:
            shipment.commercialInvoiceNumber ??
            commercialInvoiceNumber(order.number),
          incoterm: shipment.incoterm ?? "DAP",
          reasonForExport: shipment.reasonForExport ?? "permanent",
        })
        .where(eq(shipments.id, shipment.id));
      await audit(
        {
          ...auditBy(ctx),
          action: "shipment.customs_saved",
          entity: "shipment",
          entityId: shipment.id,
          before: {
            declaredValueMinor: shipment.declaredValueMinor,
            insuredValueMinor: shipment.insuredValueMinor,
            exportDeclStatus: shipment.exportDeclStatus,
          },
          after: {
            declaredValueMinor: input.declaredValueMinor,
            insuredValueMinor: input.insuredValueMinor,
            exportDeclStatus,
          },
        },
        tx,
      );
      return { exportDeclStatus };
    },
    { db: deps.db, name: "shipment.customs" },
  );
  return done(result, false);
}

// ---------------------------------------------------------------- label (claim protocol)

/** A UUID derived from a name (SHA-256, version 5 layout): `idempotency_key` for `<orderId>:<n>`. */
export function uuidFromName(name: string): string {
  const h = createHash("sha256").update(name).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The shipper from `business_profile`: the English address is free text ("1 Example St, Tel Aviv
 * 6100000"), read as line 1, then the part holding the postal code is the city. Null when it
 * cannot be read (the painter completes the profile; a go-live item).
 */
export function shipperFromProfile(
  profile: BusinessProfile,
): ShipmentParty | null {
  const parts = profile.address.en
    .split(/\n|,/)
    .map((p) => p.trim())
    .filter((p) => p && !/^israel$/i.test(p));
  if (parts.length < 2) return null;
  const line1 = parts[0] as string;
  const cityPart =
    parts.slice(1).find((p) => /\b\d{5}(\d{2})?\b/.test(p)) ??
    (parts[parts.length - 1] as string);
  const postal = /\b(\d{5}(?:\d{2})?)\b/.exec(cityPart)?.[1];
  const city = cityPart.replace(/\b\d{5}(\d{2})?\b/, "").trim();
  if (!postal || !city || !LATIN_TEXT.test(`${line1} ${city}`)) return null;
  const name = profile.artistName.en || profile.tradeName.en;
  return {
    name,
    companyName: profile.tradeName.en,
    email: profile.email,
    address: {
      name,
      line1,
      city,
      postalCode: postal,
      country: "IL",
      phone: profile.phoneIntl.replace(/[^\d+]/g, ""),
    },
  };
}

/** The mock carrier needs no real shipper; the demo profile is a placeholder. */
const MOCK_SHIPPER: ShipmentParty = {
  name: "Geula Gallery (demo)",
  companyName: "Geula Gallery",
  email: "studio@example.com",
  address: {
    name: "Geula Gallery (demo)",
    line1: "Demo studio",
    city: "Tel Aviv",
    postalCode: "6100000",
    country: "IL",
    phone: "+97230000000",
  },
};

function englishMedium(a: {
  medium: string;
  surface: string;
  mediumDetailEn: string | null;
}): string {
  if (a.mediumDetailEn?.trim()) return a.mediumDetailEn.trim();
  const word = (s: string) =>
    s
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
  return `${word(a.medium)} on ${word(a.surface).toLowerCase()}`;
}

/** The label carrier of a shipment: its own carrier, or the configured one for quoted orders. */
function labelCarrierOf(
  order: Order,
  shipment: Shipment,
  env: Env,
): CarrierCode | null {
  if (shipment.carrier === "MOCK" || shipment.carrier === "DHL") {
    return shipment.carrier;
  }
  if (shipment.method === "QUOTED" && order.shipCountry !== "IL") {
    const c = carrierFor(order.shipCountry, { env });
    return c === "MANUAL" ? null : c;
  }
  return null;
}

/** Everything the carrier needs, read before the claim so a build error never strands a claim. */
async function buildCreateRequest(
  db: DbOrTx,
  order: Order,
  shipment: Shipment,
  carrier: CarrierCode,
  env: Env,
  now: Date,
): Promise<CreateShipmentRequest> {
  const international = order.shipCountry !== "IL";
  const packages = (shipment.packages ?? []) as ShipmentPackage[];
  if (packages.length === 0) {
    throw new ConflictError(
      "PACKAGES_REQUIRED",
      "confirm the packed parcel first",
    );
  }
  if (
    international &&
    (!shipment.contentsDescriptionEn ||
      shipment.exportDeclStatus === "REQUIRED")
  ) {
    throw new ConflictError(
      "CUSTOMS_REQUIRED",
      "complete the customs step (description and export declaration)",
    );
  }
  const [profile, items] = await Promise.all([
    getSetting("business_profile", db),
    db
      .select({
        priceMinor: orderItems.priceMinor,
        declaredValueMinor: orderItems.declaredValueMinor,
        medium: artworks.medium,
        surface: artworks.surface,
        mediumDetailEn: artworks.mediumDetailEn,
        yearCreated: artworks.yearCreated,
        countryOfOrigin: artworks.countryOfOrigin,
      })
      .from(orderItems)
      .innerJoin(artworks, eq(artworks.id, orderItems.artworkId))
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.createdAt)),
  ]);
  const shipper =
    shipperFromProfile(profile) ?? (carrier === "MOCK" ? MOCK_SHIPPER : null);
  if (!shipper) {
    throw new ConflictError(
      "SHIPPER_ADDRESS",
      "the business profile needs an English address (line, city and postal code)",
    );
  }
  const phone = (order.shipPhone ?? order.buyerPhone ?? "").replace(
    /[^\d+]/g,
    "",
  );
  if (!order.shipLine1 || !order.shipCity || !order.buyerEmail || !phone) {
    throw new ConflictError(
      "RECIPIENT_ADDRESS",
      "the delivery address is incomplete",
    );
  }
  const recipientAddress: PostalAddress = {
    name: order.shipName ?? order.buyerName ?? "",
    line1: order.shipLine1,
    ...(order.shipLine2 ? { line2: order.shipLine2 } : {}),
    city: order.shipCity,
    ...(order.shipRegion ? { region: order.shipRegion } : {}),
    ...(order.shipPostalCode ? { postalCode: order.shipPostalCode } : {}),
    country: order.shipCountry,
    phone,
  };
  const totalWeight = packages.reduce((s, p) => s + p.weightG, 0);
  const artistName = profile.artistName.en;
  const declaredCurrency = shipment.declaredCurrency ?? order.currency;
  const quote = (order.shippingQuote ?? null) as ShippingQuoteResult | null;
  let insured: number | undefined;
  if ((shipment.insuredValueMinor ?? 0) > 0) {
    insured =
      declaredCurrency === "ILS"
        ? (shipment.insuredValueMinor as number)
        : insuredValueInCurrency({
            insured: true,
            insuredValueMinor: shipment.insuredValueMinor as number,
            currency: "USD",
            fxIlsPerUsd:
              quote?.fxIlsPerUsd ??
              (order.fxIlsPerUnit ? Number(order.fxIlsPerUnit) : undefined),
          });
  }
  const firstMedium = items[0] ? englishMedium(items[0]) : "";
  const declaredValueMinor =
    shipment.declaredValueMinor ?? order.itemsTotalMinor;
  const lineValues = declaredLineValues(
    declaredValueMinor,
    items.map((i) => i.declaredValueMinor ?? i.priceMinor),
  );
  return {
    orderNumber: order.number,
    plannedShippingDate: jerusalemDateKey(now),
    shipper,
    recipient: {
      name: recipientAddress.name,
      ...(order.buyerCompanyName
        ? { companyName: order.buyerCompanyName }
        : {}),
      email: order.buyerEmail,
      address: recipientAddress,
    },
    packages,
    isCustomsDeclarable: international,
    declaredValueMinor,
    declaredCurrency,
    ...(insured ? { insuredValueMinor: insured } : {}),
    incoterm: "DAP",
    exportReason: "permanent",
    invoiceNumber:
      shipment.commercialInvoiceNumber ?? commercialInvoiceNumber(order.number),
    contentsDescriptionEn: contentsDescriptionShort(firstMedium),
    lineItems: items.map((i, n) => ({
      description:
        items.length === 1 && shipment.contentsDescriptionEn
          ? shipment.contentsDescriptionEn
          : customsDescriptionEn({
              mediumText: englishMedium(i),
              yearCreated: i.yearCreated,
              artistName,
            }),
      quantity: 1 as const,
      valueMinor: lineValues[n] ?? 0,
      exportCommodityCode: EXPORT_COMMODITY_CODE,
      importCommodityCode: importCommodityCode(order.shipCountry),
      originCountry: i.countryOfOrigin ?? "IL",
      weightG: Math.max(1, Math.round(totalWeight / items.length)),
    })),
    paperlessTrade: carrier === "DHL" && env.DHL_PAPERLESS_TRADE,
  };
}

/** A refusal we know left nothing behind at the carrier. */
function isDefinitiveRefusal(error: unknown): boolean {
  if (error instanceof ProviderNotConfiguredError) return true;
  if (!isProviderError(error)) return false;
  if (error.outcomeUnknown) return false;
  return (
    error.status !== undefined && error.status >= 400 && error.status < 500
  );
}

export interface LabelResult {
  status: ShipmentStatus;
  waybill?: string;
  /** Set when the carrier refused (`PACKED`) or the outcome is unknown (`LABEL_UNKNOWN`). */
  error?: "LABEL_REJECTED" | "LABEL_UNKNOWN";
}

/**
 * Step 3b "Buy label" (spec §5.5) with the claim protocol described in the file header.
 * `shipmentId` is the shipment row id.
 */
export async function requestLabel(
  shipmentId: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<LabelResult>> {
  const db = deps.db ?? defaultDb;
  const env = deps.env ?? defaultEnv;
  const now = deps.now ?? (() => new Date());
  const [row] = await db
    .select({ orderId: shipments.orderId })
    .from(shipments)
    .where(eq(shipments.id, shipmentId));
  if (!row) throw new NotFoundError("shipment", shipmentId);

  // Build everything first, outside any transaction, from a consistent read.
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, row.orderId));
  const [current] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.id, shipmentId));
  if (!order || !current) throw new NotFoundError("shipment", shipmentId);
  const block = fulfillmentBlock(
    order,
    current,
    await openCancellationStatuses(db, order.id),
  );
  if (block) throw new FulfillmentBlockedError(block);
  requireStatus(current, ["PACKED"]);
  const carrierCode = labelCarrierOf(order, current, env);
  if (!carrierCode) {
    throw new ConflictError(
      "NO_LABEL_CARRIER",
      "this shipment has no label carrier",
    );
  }
  const adapter = deps.carrier ?? carrierAdapter(carrierCode, { env });
  if (!adapter.capabilities.labels || !adapter.createShipment) {
    throw new ConflictError(
      "NO_LABEL_CARRIER",
      "the carrier does not issue labels",
    );
  }
  const request = await buildCreateRequest(
    db,
    order,
    current,
    carrierCode,
    env,
    now(),
  );

  // 1. Claim (committed before the call).
  const claim = await withTx(
    async (tx) => {
      const { order: o, shipment } = await lockForFulfillment(tx, order.id);
      requireStatus(shipment, ["PACKED"]);
      const attempt = shipment.labelAttempt + 1;
      const idempotencyKey = uuidFromName(`${o.id}:${attempt}`);
      const messageReference = randomUUID();
      await applyShipmentStatus(tx, {
        order: o,
        shipment,
        from: ["PACKED"],
        to: "LABEL_REQUESTED",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "SYSTEM",
        patch: {
          labelAttempt: attempt,
          idempotencyKey,
          messageReference,
          carrier: carrierCode,
          adapterMode: adapter.mode,
        },
        event: { code: `LABEL_REQUESTED_${attempt}` },
      });
      return { attempt, idempotencyKey, messageReference };
    },
    { db, name: "shipment.label_claim" },
  );

  // 2. The carrier call, outside any transaction.
  let created: Awaited<
    ReturnType<NonNullable<CarrierAdapter["createShipment"]>>
  >;
  try {
    created = await adapter.createShipment(request, {
      idempotencyKey: claim.idempotencyKey,
      messageReference: claim.messageReference,
    });
  } catch (error) {
    const definitive = isDefinitiveRefusal(error);
    const to: ShipmentStatus = definitive ? "PACKED" : "LABEL_UNKNOWN";
    const summary = {
      attempt: claim.attempt,
      error: (error as Error)?.name ?? "Error",
      message: String((error as Error)?.message ?? error).slice(0, 300),
      ...(isProviderError(error) && error.status
        ? { status: error.status }
        : {}),
    };
    log.warn("shipment.label_failed", { shipmentId, to, ...summary });
    await withTx(
      async (tx) => {
        const { order: o, shipment } = await lockForFulfillment(tx, order.id, {
          guard: false,
        });
        await applyShipmentStatus(tx, {
          order: o,
          shipment,
          from: ["LABEL_REQUESTED"],
          to,
          actor: ctx.actor,
          ipHash: ctx.ipHash,
          source: "SYSTEM",
          patch: { providerResponseRedacted: summary },
          event: {
            code: `${to}_${claim.attempt}`,
            description: summary.message,
          },
          action: definitive
            ? "shipment.label_rejected"
            : "shipment.label_unknown",
        });
        if (!definitive) {
          await raiseAlert(
            {
              severity: "WARNING",
              kind: "LABEL_UNKNOWN",
              dedupeKey: `label-unknown:${shipment.id}:${claim.attempt}`,
              entity: "shipment",
              entityId: shipment.id,
              params: { orderNumber: o.number, attempt: claim.attempt },
            },
            tx,
          );
        }
      },
      { db, name: "shipment.label_failed" },
    );
    return done(
      {
        status: to,
        error: definitive
          ? ("LABEL_REJECTED" as const)
          : ("LABEL_UNKNOWN" as const),
      },
      false,
    );
  }

  // 3. Files first (private), then the result transaction. A storage failure never loses the
  //    waybill: the label can be downloaded again from the carrier.
  const store = deps.storage ?? defaultStorage();
  const safe = created.waybill.replace(/[^A-Za-z0-9]/g, "");
  let labelFileKey: string | null = `labels/${shipmentId}/${safe}-label.pdf`;
  let invoiceFileKey: string | null = created.invoicePdf
    ? `labels/${shipmentId}/${safe}-invoice.pdf`
    : null;
  try {
    await store.put(labelFileKey, created.labelPdf, {
      access: "private",
      contentType: "application/pdf",
    });
    if (invoiceFileKey && created.invoicePdf) {
      await store.put(invoiceFileKey, created.invoicePdf, {
        access: "private",
        contentType: "application/pdf",
      });
    }
  } catch (error) {
    log.error("shipment.label_store_failed", { shipmentId }, error);
    labelFileKey = null;
    invoiceFileKey = null;
  }
  try {
    await withTx(
      async (tx) => {
        const { order: o, shipment } = await lockForFulfillment(tx, order.id, {
          guard: false,
        });
        await applyShipmentStatus(tx, {
          order: o,
          shipment,
          from: ["LABEL_REQUESTED"],
          to: "LABEL_CREATED",
          actor: ctx.actor,
          ipHash: ctx.ipHash,
          source: "SYSTEM",
          patch: {
            trackingNumber: created.waybill,
            trackingUrl: created.trackingUrl || null,
            carrierName: carrierCode === "DHL" ? "DHL Express" : "Mock carrier",
            serviceCode: carrierCode === "DHL" ? "P" : "MOCK",
            labelFileKey,
            invoiceFileKey,
            providerShipmentId: created.providerShipmentId ?? created.waybill,
            providerResponseRedacted: (created.rawRedacted ?? null) as never,
          },
          event: { code: "LABEL_CREATED", description: created.waybill },
        });
        if (!labelFileKey) {
          await raiseAlert(
            {
              severity: "WARNING",
              kind: "LABEL_FILE_MISSING",
              dedupeKey: `label-file:${shipment.id}:${claim.attempt}`,
              entity: "shipment",
              entityId: shipment.id,
              params: { orderNumber: o.number, waybill: created.waybill },
            },
            tx,
          );
        }
      },
      { db, name: "shipment.label_created" },
    );
  } catch (error) {
    // The carrier created a label but we could not record it: never PACKED (a second label would
    // be bought). LABEL_UNKNOWN keeps the waybill in the alert for the admin.
    log.error("shipment.label_record_failed", { shipmentId }, error);
    await withTx(
      async (tx) => {
        const { order: o, shipment } = await lockForFulfillment(tx, order.id, {
          guard: false,
        });
        if (shipment.status !== "LABEL_REQUESTED") return;
        await applyShipmentStatus(tx, {
          order: o,
          shipment,
          from: ["LABEL_REQUESTED"],
          to: "LABEL_UNKNOWN",
          actor: ctx.actor,
          source: "SYSTEM",
          event: { code: `LABEL_UNKNOWN_${claim.attempt}` },
        });
        await raiseAlert(
          {
            severity: "CRITICAL",
            kind: "LABEL_UNKNOWN",
            dedupeKey: `label-unknown:${shipment.id}:${claim.attempt}`,
            entity: "shipment",
            entityId: shipment.id,
            params: { orderNumber: o.number, waybill: created.waybill },
          },
          tx,
        );
      },
      { db, name: "shipment.label_record_failed" },
    );
    return done({ status: "LABEL_UNKNOWN", error: "LABEL_UNKNOWN" as const });
  }
  return done({ status: "LABEL_CREATED", waybill: created.waybill });
}

/** A claim older than this with no result is treated as unknown (the process died mid-call). */
export const STALE_LABEL_REQUEST_MS = 2 * 60_000;

/**
 * LABEL_REQUESTED that never finished (crash between the claim and the result) → LABEL_UNKNOWN,
 * so the admin resolves it like a timeout. Refused while the claim is fresh.
 */
export async function markLabelRequestUnknown(
  orderId: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  const now = (deps.now ?? (() => new Date()))();
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId, {
        guard: false,
      });
      requireStatus(shipment, ["LABEL_REQUESTED"]);
      if (
        now.getTime() - shipment.updatedAt.getTime() <
        STALE_LABEL_REQUEST_MS
      ) {
        throw new ConflictError(
          "LABEL_REQUEST_IN_FLIGHT",
          "the label request is still running",
        );
      }
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["LABEL_REQUESTED"],
        to: "LABEL_UNKNOWN",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
        event: { code: `LABEL_UNKNOWN_${shipment.labelAttempt}` },
      });
    },
    { db: deps.db, name: "shipment.label_stale" },
  );
  return done({ status: "LABEL_UNKNOWN" as ShipmentStatus }, false);
}

/**
 * LABEL_UNKNOWN, resolved by the admin after checking MyDHL:
 * - `found`: the label exists → LABEL_CREATED with that waybill (no file; download it there);
 * - `none`: no label exists → LABEL_REQUESTED → PACKED, so "Buy label" claims attempt n+1.
 */
export async function resolveUnknownLabel(
  orderId: string,
  input: { outcome: "found"; waybill: string } | { outcome: "none" },
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  try {
    const status = await withTx(
      async (tx) => {
        const { order, shipment } = await lockForFulfillment(tx, orderId, {
          guard: false,
        });
        requireStatus(shipment, ["LABEL_UNKNOWN"]);
        if (input.outcome === "found") {
          const waybill = input.waybill.trim().toUpperCase();
          if (!/^[0-9A-Z]{6,20}$/.test(waybill)) {
            throw new ValidationError(
              "WAYBILL_INVALID",
              "waybill: 6–20 letters or digits",
            );
          }
          await applyShipmentStatus(tx, {
            order,
            shipment,
            from: ["LABEL_UNKNOWN"],
            to: "LABEL_CREATED",
            actor: ctx.actor,
            ipHash: ctx.ipHash,
            source: "MANUAL",
            patch: {
              trackingNumber: waybill,
              trackingUrl:
                shipment.carrier === "DHL"
                  ? carrierAdapter("DHL").trackingUrl(waybill, "en")
                  : null,
              carrierName:
                shipment.carrier === "DHL" ? "DHL Express" : "Mock carrier",
            },
            event: { code: "LABEL_FOUND", description: waybill },
            action: "shipment.label_found",
          });
          return "LABEL_CREATED" as const;
        }
        const confirmedAt = new Date();
        await applyShipmentStatus(tx, {
          order,
          shipment,
          from: ["LABEL_UNKNOWN"],
          to: "LABEL_REQUESTED",
          actor: ctx.actor,
          ipHash: ctx.ipHash,
          source: "MANUAL",
          event: {
            occurredAt: confirmedAt,
            code: `NO_LABEL_CONFIRMED_${shipment.labelAttempt}`,
          },
          action: "shipment.no_label_confirmed",
        });
        const [again] = await tx
          .select()
          .from(shipments)
          .where(eq(shipments.id, shipment.id));
        await applyShipmentStatus(tx, {
          order,
          shipment: again as Shipment,
          from: ["LABEL_REQUESTED"],
          to: "PACKED",
          actor: ctx.actor,
          ipHash: ctx.ipHash,
          source: "MANUAL",
          event: {
            occurredAt: new Date(confirmedAt.getTime() + 1),
            code: `PACKED_AFTER_${shipment.labelAttempt}`,
          },
        });
        return "PACKED" as const;
      },
      { db: deps.db, name: "shipment.label_resolve" },
    );
    return done({ status });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "TRACKING_NUMBER_IN_USE",
        "this waybill is already recorded",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------- manual tracking

export interface ManualTrackingInput {
  carrierName: string;
  trackingNumber: string;
  trackingUrl?: string | null;
  /** The parcel was handed to the carrier: LABEL_CREATED → IN_TRANSIT. */
  handedOver?: boolean;
}

const MANUAL_TRACKING_FROM = [
  "AWAITING_FULFILLMENT",
  "PACKED",
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
] as const satisfies readonly ShipmentStatus[];

/**
 * Step 3a "Manual tracking" (spec §5.5): the carrier name and tracking number of a parcel sent
 * outside the integrated carriers → LABEL_CREATED (via PACKED when the order page's quick form
 * skips the packing step), then IN_TRANSIT when it was handed over. A shipment already past
 * LABEL_CREATED only gets its tracking details corrected. Carrier methods only.
 */
export async function recordManualTracking(
  orderId: string,
  input: ManualTrackingInput,
  ctx: AdminContext,
  deps: { db?: Db } = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  const carrierName = input.carrierName.trim();
  const trackingNumber = input.trackingNumber.trim();
  if (!carrierName || !trackingNumber) {
    throw new ValidationError(
      "TRACKING_REQUIRED",
      "carrier name and tracking number are required",
    );
  }
  try {
    const status = await withTx(
      async (tx) => {
        const { order, shipment } = await lockForFulfillment(tx, orderId);
        if (!isCarrierMethod(shipment)) {
          throw new ConflictError(
            "NOT_A_CARRIER_SHIPMENT",
            "pickup and artist delivery have no tracking",
          );
        }
        if (
          !(MANUAL_TRACKING_FROM as readonly string[]).includes(shipment.status)
        ) {
          throw new ConflictError(
            "SHIPMENT_STATE",
            `cannot record tracking in ${shipment.status}`,
          );
        }
        const details = {
          carrier: "MANUAL" as const,
          carrierName,
          trackingNumber,
          trackingUrl: input.trackingUrl?.trim() || null,
        };
        const steps: ShipmentStatus[] = [];
        let current: ShipmentStatus = shipment.status;
        if (current === "AWAITING_FULFILLMENT") steps.push("PACKED");
        if (current === "AWAITING_FULFILLMENT" || current === "PACKED") {
          steps.push("LABEL_CREATED");
        }
        if (input.handedOver) steps.push("IN_TRANSIT");
        if (steps.length === 0) {
          await tx
            .update(shipments)
            .set(details)
            .where(eq(shipments.id, shipment.id));
          await audit(
            {
              ...auditBy(ctx),
              action: "shipment.tracking_corrected",
              entity: "shipment",
              entityId: shipment.id,
              after: { carrierName, trackingNumber },
            },
            tx,
          );
          return current;
        }
        let row = shipment;
        for (const to of steps) {
          row = await applyShipmentStatus(tx, {
            order,
            shipment: row,
            from: [current],
            to,
            actor: ctx.actor,
            ipHash: ctx.ipHash,
            source: "MANUAL",
            patch: details,
            event: {
              code: `MANUAL_${to}`,
              description: to === "LABEL_CREATED" ? carrierName : null,
            },
          });
          current = to;
        }
        return current;
      },
      { db: deps.db, name: "shipment.manual_tracking" },
    );
    return done({ status });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "TRACKING_NUMBER_IN_USE",
        "this tracking number is already recorded for another shipment",
      );
    }
    throw error;
  }
}

/** "Handed over" (spec §5.5 3a): LABEL_CREATED / PICKUP_SCHEDULED → IN_TRANSIT. */
export async function markHandedOver(
  orderId: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      requireStatus(shipment, ["LABEL_CREATED", "PICKUP_SCHEDULED"]);
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["LABEL_CREATED", "PICKUP_SCHEDULED"],
        to: "IN_TRANSIT",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
        event: { code: "MANUAL_HANDED_OVER" },
      });
    },
    { db: deps.db, name: "shipment.handed_over" },
  );
  return done({ status: "IN_TRANSIT" as ShipmentStatus });
}

export const MANUAL_EVENT_STATUSES = [
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "RETURNED",
] as const satisfies readonly ShipmentStatus[];
export type ManualEventStatus = (typeof MANUAL_EVENT_STATUSES)[number];

/**
 * A tracking event typed in by the admin (spec §5.6 "Manual carriers: the admin adds events by
 * hand"). With a status, the shipment moves along the machine (refused otherwise); without one,
 * the event is a note. Manual-carrier parcels only (integrated carriers are polled).
 */
export async function addManualEvent(
  orderId: string,
  input: {
    status: ManualEventStatus | null;
    occurredAt: Date;
    description: string;
    location?: string | null;
  },
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  const description = input.description.trim();
  if (!description)
    throw new ValidationError("DESCRIPTION_REQUIRED", "description");
  if (
    Number.isNaN(input.occurredAt.getTime()) ||
    input.occurredAt.getTime() > Date.now() + 60_000
  ) {
    throw new ValidationError(
      "EVENT_TIME_INVALID",
      "the event time is in the future",
    );
  }
  const status = await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId, {
        guard: false,
      });
      if (!isCarrierMethod(shipment) || shipment.carrier !== "MANUAL") {
        throw new ConflictError(
          "NOT_MANUAL_CARRIER",
          "events are added by hand for manual carriers only",
        );
      }
      if (order.status !== "PAID" && order.status !== "COMPLETED") {
        throw new ConflictError("ORDER_NOT_PAID", "the order is not paid");
      }
      if (input.status === null) {
        await tx
          .insert(shipmentEvents)
          .values({
            shipmentId: shipment.id,
            occurredAt: input.occurredAt,
            status: null,
            code: "MANUAL_NOTE",
            description,
            location: input.location?.trim() || null,
            source: "MANUAL",
          })
          .onConflictDoNothing();
        await audit(
          {
            ...auditBy(ctx),
            action: "shipment.note",
            entity: "shipment",
            entityId: shipment.id,
          },
          tx,
        );
        return shipment.status;
      }
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: [shipment.status],
        to: input.status,
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
        event: {
          occurredAt: input.occurredAt,
          code: `MANUAL_${input.status}`,
          description,
          location: input.location?.trim() || null,
        },
      });
      return input.status;
    },
    { db: deps.db, name: "shipment.manual_event" },
  );
  return done({ status });
}

// ---------------------------------------------------------------- pickup and artist delivery

/**
 * Step 3c "Pickup" (spec §5.5): AWAITING_FULFILLMENT → READY_FOR_PICKUP; the `ready-for-pickup`
 * email reveals the studio address.
 */
export async function markReadyForPickup(
  orderId: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      if (shipment.method !== "LOCAL_PICKUP") {
        throw new ConflictError("NOT_PICKUP", "not a pickup order");
      }
      requireStatus(shipment, ["AWAITING_FULFILLMENT"]);
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["AWAITING_FULFILLMENT"],
        to: "READY_FOR_PICKUP",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
      });
    },
    { db: deps.db, name: "shipment.ready_for_pickup" },
  );
  return done({ status: "READY_FOR_PICKUP" as ShipmentStatus });
}

/**
 * The disclosure guard on hand-over (spec §5.5 3c/3d, §5.3 #31): the buyer must have received the
 * disclosure by email (`disclosure_sent_at`), or the admin confirms that the printed copy was
 * handed over (`disclosure_handed_over_at`, set now).
 */
async function disclosureGuard(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  order: Order,
  handedOver: boolean,
): Promise<void> {
  if (order.disclosureSentAt || order.disclosureHandedOverAt) return;
  if (!handedOver) {
    throw new ConflictError(
      "DISCLOSURE_REQUIRED",
      "the disclosure document was not emailed: confirm that the printed copy was handed over",
    );
  }
  await tx
    .update(orders)
    .set({ disclosureHandedOverAt: new Date() })
    .where(eq(orders.id, order.id));
}

/** READY_FOR_PICKUP → COLLECTED, behind the disclosure guard. */
export async function markCollected(
  orderId: string,
  input: { disclosureHandedOver: boolean },
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      requireStatus(shipment, ["READY_FOR_PICKUP"]);
      await disclosureGuard(tx, order, input.disclosureHandedOver);
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["READY_FOR_PICKUP"],
        to: "COLLECTED",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
      });
    },
    { db: deps.db, name: "shipment.collected" },
  );
  return done({ status: "COLLECTED" as ShipmentStatus });
}

/** Step 3d "Artist delivery": PACKED → OUT_FOR_DELIVERY. */
export async function startArtistDelivery(
  orderId: string,
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      if (shipment.method !== "ARTIST_DELIVERY") {
        throw new ConflictError(
          "NOT_ARTIST_DELIVERY",
          "not an artist delivery",
        );
      }
      requireStatus(shipment, ["PACKED"]);
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["PACKED"],
        to: "OUT_FOR_DELIVERY",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
      });
    },
    { db: deps.db, name: "shipment.artist_out" },
  );
  return done({ status: "OUT_FOR_DELIVERY" as ShipmentStatus });
}

/** Artist delivery OUT_FOR_DELIVERY → DELIVERED, behind the disclosure guard. */
export async function markArtistDelivered(
  orderId: string,
  input: { disclosureHandedOver: boolean },
  ctx: AdminContext,
  deps: ShipmentDeps = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  await withTx(
    async (tx) => {
      const { order, shipment } = await lockForFulfillment(tx, orderId);
      if (shipment.method !== "ARTIST_DELIVERY") {
        throw new ConflictError(
          "NOT_ARTIST_DELIVERY",
          "not an artist delivery",
        );
      }
      requireStatus(shipment, ["OUT_FOR_DELIVERY"]);
      await disclosureGuard(tx, order, input.disclosureHandedOver);
      await applyShipmentStatus(tx, {
        order,
        shipment,
        from: ["OUT_FOR_DELIVERY"],
        to: "DELIVERED",
        actor: ctx.actor,
        ipHash: ctx.ipHash,
        source: "MANUAL",
      });
    },
    { db: deps.db, name: "shipment.artist_delivered" },
  );
  return done({ status: "DELIVERED" as ShipmentStatus });
}

// ---------------------------------------------------------------- cancellation (WS6 hook)

const CANCELLABLE: readonly ShipmentStatus[] = [
  "AWAITING_FULFILLMENT",
  "PACKED",
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
  "READY_FOR_PICKUP",
];

/**
 * For an accepted cancellation that was not shipped yet (spec §5.7 step 7): the shipment →
 * CANCELLED in the caller's transaction (the caller holds the order lock). Returns `shipped: true`
 * when the parcel already left (the cancellation then waits for the return), and refuses while a
 * label call is in flight or unknown. A booked DHL pickup is returned for the caller to cancel
 * after commit.
 */
export async function cancelShipmentForOrder(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  orderId: string,
  actor: string,
): Promise<{
  cancelled: boolean;
  shipped: boolean;
  pickupConfirmation: string | null;
}> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order", orderId);
  const shipment = await lockShipmentOf(tx, orderId);
  if (!shipment || shipment.status === "CANCELLED") {
    return { cancelled: false, shipped: false, pickupConfirmation: null };
  }
  if (
    shipment.status === "LABEL_REQUESTED" ||
    shipment.status === "LABEL_UNKNOWN"
  ) {
    throw new ConflictError(
      "LABEL_IN_FLIGHT",
      "resolve the label request first",
    );
  }
  if (!CANCELLABLE.includes(shipment.status)) {
    return { cancelled: false, shipped: true, pickupConfirmation: null };
  }
  await applyShipmentStatus(tx, {
    order,
    shipment,
    from: CANCELLABLE,
    to: "CANCELLED",
    actor,
    source: "SYSTEM",
  });
  return {
    cancelled: true,
    shipped: false,
    pickupConfirmation: shipment.pickupConfirmation,
  };
}

/** The ILS value of a shipment's declared amount (reports, thresholds). */
export function declaredValueIls(
  s: Pick<Shipment, "declaredValueMinor" | "declaredCurrency">,
  ilsPerUsd: number,
): number {
  const v = s.declaredValueMinor ?? 0;
  return s.declaredCurrency === "USD" ? usdToIls(v, ilsPerUsd) : v;
}
