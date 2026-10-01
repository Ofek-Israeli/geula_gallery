import "server-only";
import type { ZoneId } from "@/lib/countries";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import type { PostalAddress } from "@/lib/validation/address";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import type { Env } from "@/server/env";
import type { FetchLike } from "@/server/integrations/http";

/**
 * Shipping contract (spec §4.4, frozen at `contracts-v1`): the pure rate/rules engine types and the
 * carrier adapter interface. Lengths in mm, weights in g, money in minor units.
 */
export type { ShippingSettings, ZoneId } from "@/server/settings/schemas";

export type SizeClass = "S" | "M" | "L" | "QUOTE";
export type ShippingMethod =
  | "CARRIER_TABLE"
  | "LOCAL_PICKUP"
  | "ARTIST_DELIVERY"
  | "QUOTED";
export type CarrierCode = "DHL" | "MANUAL" | "MOCK";
export type PackagingType =
  | "ROLLED_TUBE"
  | "FLAT_BOX"
  | "STRETCHED_BOX"
  | "FRAMED_BOX"
  | "CRATE";
export type Glazing = "NONE" | "GLASS" | "ACRYLIC";

/** What the engine needs about one artwork (from `artworks`). */
export interface ArtworkShipSpec {
  artworkId: string;
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
  packagingType: PackagingType;
  canBeRolled: boolean;
  packedLengthMm: number;
  packedWidthMm: number;
  packedHeightMm: number;
  packedWeightG: number;
  sizeClassOverride: SizeClass | null;
  glazing: Glazing;
  framed: boolean;
  shipsInternationally: boolean;
  localPickupOnly: boolean;
  quoteOnly: boolean;
  /** Caps the insured value (null = no artwork-specific cap). */
  maxInsurableValueMinor: number | null;
  dispatchDays: number;
}

/** The dated reference rates from `settings.checkout.fx`. */
export interface FxReference {
  ilsPerUsd: number;
  ilsPerEur: number;
  ilsPerGbp: number;
  /** ISO date. */
  asOf: string;
}

export type BlockReason =
  | "DESTINATION_DENIED"
  | "ZONE_DISABLED"
  | "NOT_INTERNATIONAL"
  | "QUOTE_ONLY"
  | "SIZE_QUOTE"
  | "VALUE_CAP"
  | "GB_LOW_VALUE";

export type NoticeCode =
  | "DAP_DUTIES"
  | "EU_LOW_VALUE_DUTY"
  | "US_DUTY_FREE_CLEARANCE_FEES"
  | "US_FORMAL_ENTRY"
  | "TRANSIT_ESTIMATE";

export interface ClassifyResult {
  sizeClass: SizeClass;
  chargeableG: number;
  oversizePiece: boolean;
  nonConveyable: boolean;
  reasons: string[];
}

export interface DestinationEvaluation {
  mode: "ok" | "quote_only" | "blocked";
  reason?: BlockReason;
  notices: NoticeCode[];
}

/** One priced shipping method for a destination (snapshotted into `orders.shipping_quote`). */
export interface ShippingQuoteResult extends DestinationEvaluation {
  zone: ZoneId | null;
  method: ShippingMethod;
  carrier: CarrierCode | null;
  sizeClass: SizeClass;
  chargeableG: number;
  currency: Currency;
  /** Base rate + per-piece fees + active surcharges, in `currency`. */
  shippingMinor: number;
  insuranceMinor: number;
  /** True only when the quote actually includes insurance (the UI may say "insured" only then). */
  insured: boolean;
  /** min(declared value, artwork cap, settings cap), in ILS minor units. */
  insuredValueMinor: number;
  breakdown: {
    baseMinor: number;
    pieceFeesMinor: number;
    surchargesMinor: number;
  };
  /** Locked FX for USD orders (whole dollars, rounded up). */
  fxIlsPerUsd?: number;
  estimate?: { he: string; en: string };
}

export interface QuoteShippingInput {
  items: ArtworkShipSpec[];
  country: string;
  method?: ShippingMethod;
  currency: Currency;
  date: Date;
  declaredValueIlsMinor: number;
  settings: import("@/server/settings/schemas").ShippingSettings;
  fx: FxReference;
  carrier: CarrierCode;
}

export type ZoneEstimate =
  | { fromIlsMinor: number; insured: boolean }
  | "QUOTE"
  | "UNAVAILABLE";

// ---------------------------------------------------------------- carriers

export interface ShipmentParty {
  name: string;
  companyName?: string;
  address: PostalAddress;
  email: string;
}

export interface ShipmentPackage {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: number;
}

export interface CustomsLineItem {
  description: string;
  quantity: 1;
  valueMinor: number;
  /** Outbound commodity code (`9701910000`). */
  exportCommodityCode: string;
  /** Inbound code for the destination (US `9701.91.0000`, EU `97019100`, …). */
  importCommodityCode?: string;
  originCountry: string;
  weightG: number;
}

export interface CreateShipmentRequest {
  orderNumber: string;
  plannedShippingDate: string;
  shipper: ShipmentParty;
  recipient: ShipmentParty;
  packages: ShipmentPackage[];
  isCustomsDeclarable: boolean;
  declaredValueMinor: number;
  declaredCurrency: Currency;
  /** Present only when insured (`II` value-added service). */
  insuredValueMinor?: number;
  incoterm: "DAP";
  exportReason: "permanent";
  invoiceNumber: string;
  contentsDescriptionEn: string;
  lineItems: CustomsLineItem[];
  paperlessTrade: boolean;
}

export interface PickupRequest {
  plannedDate: string;
  readyByTime: string;
  closeTime: string;
  location: ShipmentParty;
  packages: ShipmentPackage[];
  waybills: string[];
}

export interface NormalizedTrackingEvent {
  /** ISO timestamp. */
  occurredAt: string;
  code: string;
  description: string;
  location?: string;
  /** Null for unknown codes: recorded, never changes the status (spec §4.4 `dhl-map.ts`). */
  status: ShipmentStatus | null;
}

export interface CarrierAdapter {
  id: "mock" | "manual" | "dhl";
  mode: "mock" | "manual" | "test" | "live";
  capabilities: {
    rates: boolean;
    labels: boolean;
    pickup: boolean;
    tracking: boolean;
    landedCost: boolean;
    paperlessTrade: boolean;
    insurance: boolean;
  };
  createShipment?(
    r: CreateShipmentRequest,
    ctx: { idempotencyKey: string; messageReference: string },
  ): Promise<{
    waybill: string;
    trackingUrl: string;
    labelPdf: Uint8Array;
    invoicePdf?: Uint8Array;
    providerShipmentId?: string;
    rawRedacted: unknown;
  }>;
  requestPickup?(r: PickupRequest): Promise<{ confirmationNumber: string }>;
  cancelPickup?(confirmationNumber: string): Promise<void>;
  track?(
    waybill: string,
  ): Promise<{ events: NormalizedTrackingEvent[]; deliveredAt?: string }>;
  trackingUrl(waybill: string, locale: Locale): string;
}

export interface CarrierFactoryInput {
  env: Env;
  fetch?: FetchLike;
}
