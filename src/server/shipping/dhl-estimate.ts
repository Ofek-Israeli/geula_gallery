import "server-only";
import { jerusalemDateKey } from "@/lib/format";
import { applyBasisPoints } from "@/lib/money";
import { vatRateBpOn } from "@/lib/vat";
import type { DhlEstimateSettings } from "@/server/settings/schemas";
import { mmToCmCeil } from "./carriers/dhl-map";
import { type DhlTariff, dhlTariffOn } from "./tariff";
import type {
  DhlDemandRegion,
  DhlEstimateDetail,
  DhlEstimatePiece,
  DhlPieceSurcharge,
  DhlZone,
} from "./types";

/**
 * The DHL Express Worldwide estimate for shipments abroad: DHL's published Israel export tariff
 * (`tariff/`) applied in code, in place of a live rating call (there is no DHL account yet).
 * Pure; integer maths in ILS minor units. docs/pricing/shipping-taxes-and-fees.tex explains it and
 * `tests/unit/dhl-estimate.test.ts` pins its examples.
 *
 * 1. Each piece is measured as DHL measures it: sides in whole cm rounded up (as on the label),
 *    volumetric weight = cm³ / 5000 kg, billing weight = max(actual, volumetric) rounded up to
 *    0.5 kg. One piece surcharge at most: Overweight (> 70 kg actual or volumetric), else Oversize
 *    (longest side > 100 cm or second > 80 cm), else Non-Conveyable (25–70 kg actual, a crate or a
 *    round tube).
 * 2. The order is one multi-piece shipment (as fulfilment books it): billing weight = Σ pieces,
 *    in 0.5 kg steps up to 30 kg and whole kg above.
 * 3. Transport = the published row for that weight (or the row below plus the published
 *    increments), less the account discount.
 * 4. Demand surcharge (in its window, per kg by destination region), Elevated Risk (listed
 *    destinations), Restricted Destination (listed destinations).
 * 5. Fuel = fuel % × (transport + piece surcharges + demand + elevated risk); DHL does not apply
 *    it to Restricted Destination, insurance or customs services.
 * 6. Export declaration (110 ILS + VAT) when it is required and DHL files it.
 * 7. Total rounded up to whole shekels.
 * Not estimated: Remote Area (DHL's list is a per-address lookup), optional services.
 */

export interface DhlPieceInput {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: number;
  /** Packaging DHL handles by hand: a wooden crate or a round tube (Non-Conveyable). */
  nonConveyablePackaging: boolean;
}

export type DhlEstimateFailure =
  | "DISABLED"
  | "NO_DHL_ZONE"
  | "NO_PIECES"
  | "PIECE_LIMIT"
  | "SHIPMENT_LIMIT";

export type DhlEstimateResult =
  | { ok: true; detail: DhlEstimateDetail }
  | { ok: false; reason: DhlEstimateFailure };

/** The settings page flags a fuel surcharge older than this many days. */
export const FUEL_STALE_AFTER_DAYS = 14;

const HALF_KG_G = 500;
const KG_G = 1000;
const ZONES: readonly DhlZone[] = [1, 2, 3, 4, 5, 6];

/** ⌈a / b⌉ for non-negative integers. */
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/** a / b rounded half up, for non-negative integers. */
function halfUpDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

function zoneIn(t: DhlTariff, country: string): DhlZone | null {
  return ZONES.find((z) => t.zones[z].includes(country)) ?? null;
}

function regionIn(t: DhlTariff, country: string): DhlDemandRegion {
  for (const [region, codes] of Object.entries(t.demandRegions)) {
    if (codes.includes(country)) return region as DhlDemandRegion;
  }
  return "ROW";
}

/** The DHL zone of a destination on `date`, or null when the guide does not list it (and IL). */
export function dhlZoneOf(country: string, date: Date): DhlZone | null {
  return zoneIn(dhlTariffOn(date), country);
}

/**
 * Destinations with the same key cost the same for the same pieces on `date` (zone, demand
 * region, per-shipment surcharges); null when the guide does not list the destination.
 */
export function dhlPriceKey(country: string, date: Date): string | null {
  const t = dhlTariffOn(date);
  const zone = zoneIn(t, country);
  if (zone === null) return null;
  const elevated = t.elevatedRisk.countries.includes(country);
  const restricted = t.restrictedDestination.countries.includes(country);
  return `${zone}|${regionIn(t, country)}|${elevated}|${restricted}`;
}

/** DHL's demand-surcharge region of a destination ("ROW" when not listed). */
export function dhlDemandRegionOf(
  country: string,
  date: Date,
): DhlDemandRegion {
  return regionIn(dhlTariffOn(date), country);
}

/** The demand surcharge in agorot per kg on `date` (inclusive Jerusalem days; 0 outside). */
function demandMinorPerKg(
  t: DhlTariff,
  region: DhlDemandRegion,
  date: Date,
): number {
  const day = jerusalemDateKey(date);
  const window = t.demand.find((d) => d.from <= day && day <= d.to);
  return window ? window.minorPerKg[region] : 0;
}

function transportMinor(t: DhlTariff, zone: DhlZone, billingG: number): number {
  const z = zone - 1;
  const at = (z6: readonly number[]) => z6[z] as number;
  const row = (halves: number): number => {
    const r = t.rows.find(([w]) => w === halves);
    if (!r) throw new RangeError(`no published row for ${halves / 2} kg`);
    return at(r[1]);
  };
  const halves = ceilDiv(billingG, HALF_KG_G);
  // Up to 10 kg every 0.5 kg step is published; 10–30 kg every whole kg, and a half step adds
  // the published "each additional 0.5 kg" price.
  if (halves <= 20) return row(halves);
  if (halves <= 60) {
    if (halves % 2 === 0) return row(halves);
    const extra = halves <= 40 ? t.perHalfKgAbove10 : t.perHalfKgAbove20;
    return row(halves - 1) + at(extra);
  }
  // Above 30 kg: per whole kg on top of the 30 kg (then 70 kg, 300 kg) price; the published
  // 40–70 kg rows are exactly row(30) + n × the 30.1–70 kg rate.
  const kg = ceilDiv(billingG, KG_G);
  const at30 = row(60);
  if (kg <= 70) return at30 + (kg - 30) * at(t.perKg30To70);
  const at70 = row(140);
  if (kg <= 300) return at70 + (kg - 70) * at(t.perKg70To300);
  return at70 + 230 * at(t.perKg70To300) + (kg - 300) * at(t.perKg300To3000);
}

/** The published transport price for a shipment billing weight (a 0.5 kg multiple). */
export function dhlTransportMinor(
  zone: DhlZone,
  billingG: number,
  date: Date,
): number {
  return transportMinor(dhlTariffOn(date), zone, billingG);
}

function billPiece(t: DhlTariff, p: DhlPieceInput): DhlEstimatePiece | null {
  const dimsCm = [
    mmToCmCeil(p.lengthMm),
    mmToCmCeil(p.widthMm),
    mmToCmCeil(p.heightMm),
  ].sort((a, b) => b - a) as [number, number, number];
  const [longest, second, third] = dimsCm;
  if (
    longest > t.limits.pieceLengthCm ||
    p.weightG > t.limits.pieceWeightKg * KG_G
  ) {
    return null;
  }
  const volumetricG = ceilDiv(
    longest * second * third * KG_G,
    t.divisorCm3PerKg,
  );
  const heavier = Math.max(p.weightG, volumetricG);
  const billingG = ceilDiv(heavier, HALF_KG_G) * HALF_KG_G;
  const s = t.piece;
  let surcharge: DhlPieceSurcharge | null = null;
  let surchargeMinor = 0;
  if (heavier > s.overweightKg * KG_G) {
    surcharge = "OVERWEIGHT";
    surchargeMinor = s.overweightMinor;
  } else if (longest > s.oversizeLongestCm || second > s.oversizeSecondCm) {
    surcharge = "OVERSIZE";
    surchargeMinor = s.oversizeMinor;
  } else if (
    p.nonConveyablePackaging ||
    (p.weightG >= s.nonConveyableMinKg * KG_G &&
      p.weightG <= s.nonConveyableMaxKg * KG_G)
  ) {
    surcharge = "NON_CONVEYABLE";
    surchargeMinor = s.nonConveyableMinor;
  }
  return {
    dimsCm,
    actualG: p.weightG,
    volumetricG,
    billingG,
    surcharge,
    surchargeMinor,
  };
}

export function dhlEstimate(i: {
  pieces: readonly DhlPieceInput[];
  country: string;
  date: Date;
  settings: DhlEstimateSettings;
  /** The export declaration is required (the declared value is above the threshold). */
  exportDeclaration: boolean;
}): DhlEstimateResult {
  if (!i.settings.enabled) return { ok: false, reason: "DISABLED" };
  const t = dhlTariffOn(i.date);
  const zone = zoneIn(t, i.country);
  if (zone === null) return { ok: false, reason: "NO_DHL_ZONE" };
  if (i.pieces.length === 0) return { ok: false, reason: "NO_PIECES" };

  const pieces: DhlEstimatePiece[] = [];
  for (const p of i.pieces) {
    const piece = billPiece(t, p);
    if (!piece) return { ok: false, reason: "PIECE_LIMIT" };
    pieces.push(piece);
  }
  const halves = pieces.reduce((s, p) => s + p.billingG / HALF_KG_G, 0);
  const billingG =
    halves <= 60 ? halves * HALF_KG_G : ceilDiv(halves, 2) * KG_G;
  if (billingG > t.limits.shipmentWeightKg * KG_G) {
    return { ok: false, reason: "SHIPMENT_LIMIT" };
  }

  const transport = transportMinor(t, zone, billingG);
  const discountBp = Math.round(i.settings.accountDiscountPct * 100);
  const transportNet = transport - applyBasisPoints(transport, discountBp);
  const pieceSurcharges = pieces.reduce((s, p) => s + p.surchargeMinor, 0);
  const region = regionIn(t, i.country);
  const demandPerKg = demandMinorPerKg(t, region, i.date);
  const demand = halfUpDiv(demandPerKg * billingG, KG_G);
  const elevatedRisk = t.elevatedRisk.countries.includes(i.country)
    ? t.elevatedRisk.minor
    : 0;
  const restricted = t.restrictedDestination.countries.includes(i.country)
    ? t.restrictedDestination.minor
    : 0;
  const fuelBp = Math.round(i.settings.fuelSurchargePct * 100);
  const fuel = applyBasisPoints(
    transportNet + pieceSurcharges + demand + elevatedRisk,
    fuelBp,
  );
  const decl = t.exportDeclaration;
  const exportDeclaration =
    i.exportDeclaration && i.settings.exportDeclarationByDhl
      ? decl.minor +
        (decl.plusVat ? applyBasisPoints(decl.minor, vatRateBpOn(i.date)) : 0)
      : 0;
  const subtotal =
    transportNet +
    pieceSurcharges +
    demand +
    elevatedRisk +
    restricted +
    fuel +
    exportDeclaration;
  const totalMinor = ceilDiv(subtotal, 100) * 100;
  return {
    ok: true,
    detail: {
      tariff: t.id,
      zone,
      region,
      pieces,
      billingG,
      transportMinor: transport,
      discountBp,
      transportNetMinor: transportNet,
      pieceSurchargesMinor: pieceSurcharges,
      demandPerKgMinor: demandPerKg,
      demandMinor: demand,
      elevatedRiskMinor: elevatedRisk,
      restrictedMinor: restricted,
      fuelBp,
      fuelAsOf: i.settings.fuelSurchargeAsOf,
      fuelMinor: fuel,
      exportDeclarationMinor: exportDeclaration,
      roundingMinor: totalMinor - subtotal,
      totalMinor,
    },
  };
}

/** True when the fuel surcharge was last updated more than `FUEL_STALE_AFTER_DAYS` days ago. */
export function fuelSurchargeStale(asOf: string, now: Date): boolean {
  const days =
    (Date.parse(jerusalemDateKey(now)) - Date.parse(asOf)) / 86_400_000;
  return days > FUEL_STALE_AFTER_DAYS;
}

/** True from the tariff's `reviewBy` day (DHL publishes a new guide every January). */
export function tariffReviewDue(now: Date): boolean {
  return jerusalemDateKey(now) >= dhlTariffOn(now).reviewBy;
}
