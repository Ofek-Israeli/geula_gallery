import "server-only";
import { ZONE_IDS, zoneOf } from "@/lib/countries";
import { chargeableWeightG, sortedDims } from "@/lib/dimensions";
import { jerusalemDateKey } from "@/lib/format";
import { applyBasisPoints, ilsToUsdCeilWhole } from "@/lib/money";
import type { ShippingSettings } from "@/server/settings/schemas";
import { evaluateDestination } from "./rules";
import type {
  ArtworkShipSpec,
  BlockReason,
  CarrierCode,
  ClassifyResult,
  DestinationEvaluation,
  NoticeCode,
  QuoteShippingInput,
  ShippingMethod,
  ShippingQuoteResult,
  SizeClass,
  ZoneEstimate,
  ZoneId,
} from "./types";

/**
 * The pure rate engine (spec §4.4 "Rate engine"; frozen signatures).
 *
 * Classes use **packed** dimensions sorted L ≥ W ≥ H and chargeable weight
 * max(actual, L×W×H cm / divisor kg):
 * - S: longest ≤ 50 cm and chargeable ≤ 5 kg;
 * - M: longest ≤ 100 cm, second ≤ 80 cm, chargeable ≤ 20 kg;
 * - L: anything larger up to 45 kg chargeable (an "oversize piece"; the L rate includes the fee);
 * - QUOTE: CRATE, glazing ≠ NONE, actual ≥ 25 kg, chargeable > 45 kg, `quote_only`, or a rolled
 *   tube for a work that cannot be rolled.
 * A per-artwork override wins, except that `quote_only` and actual > 70 kg are always QUOTE. When
 * an oversize piece is overridden to S or M the oversize fee is added; a non-conveyable piece
 * (25–70 kg actual) overridden out of QUOTE pays the non-conveyable fee.
 *
 * Rolled tube (only if `can_be_rolled`): length = the shorter artwork side + 100 mm, cross-section
 * 260 × 260 mm; the stored `packed_weight_g` is used.
 *
 * Price per piece = `classRatesIls[zone][class]` + per-piece fees + active surcharges (`enabled`
 * and `startsOn ≤ date ≤ endsOn`, inclusive Jerusalem calendar days; PCT of the base class rate or
 * FIXED ILS per piece; `ALL` or listed zones). Insurance on the order: insuredValue =
 * min(declared, Σ artwork caps (when every work has one), `maxInsuredIls`), premium =
 * max(ratePct × insuredValue, `minIls`), only when `insurance.enabled` and the carrier or method
 * supports it. USD converts shipping and insurance once with `fx.ilsPerUsd`, each rounded up to
 * whole dollars; `breakdown` stays in ILS minor units.
 */

export const TUBE_EXTRA_MM = 100;
export const TUBE_SECTION_MM = 260;
const KG = 1000;

const CLASS_ORDER: Record<SizeClass, number> = { S: 0, M: 1, L: 2, QUOTE: 3 };

export interface PackedBox {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

/** Tube for a rolled canvas: shorter side + 100 mm × 260 × 260 mm. */
export function rolledTubeBox(a: {
  heightMm: number;
  widthMm: number;
}): PackedBox {
  return {
    lengthMm: Math.min(a.heightMm, a.widthMm) + TUBE_EXTRA_MM,
    widthMm: TUBE_SECTION_MM,
    heightMm: TUBE_SECTION_MM,
  };
}

/** The box the carrier measures: the tube for rolled works, else the stored packed dimensions. */
export function packedBox(a: ArtworkShipSpec): PackedBox {
  if (a.packagingType === "ROLLED_TUBE" && a.canBeRolled) {
    return rolledTubeBox(a);
  }
  return {
    lengthMm: a.packedLengthMm,
    widthMm: a.packedWidthMm,
    heightMm: a.packedHeightMm,
  };
}

export function classify(a: ArtworkShipSpec, divisor = 5000): ClassifyResult {
  const box = packedBox(a);
  const [longest, second, third] = sortedDims(
    box.lengthMm,
    box.widthMm,
    box.heightMm,
  );
  const actual = a.packedWeightG;
  const chargeableG = chargeableWeightG(
    actual,
    { lengthMm: longest, widthMm: second, heightMm: third },
    divisor,
  );
  const fitsM = longest <= 1000 && second <= 800 && chargeableG <= 20 * KG;
  const oversizePiece = !fitsM;
  const nonConveyable = actual >= 25 * KG && actual <= 70 * KG;

  const reasons: string[] = [];
  if (a.packagingType === "CRATE") reasons.push("CRATE");
  if (a.packagingType === "ROLLED_TUBE" && !a.canBeRolled) {
    reasons.push("NOT_ROLLABLE");
  }
  if (a.glazing !== "NONE") reasons.push("GLAZING");
  if (actual >= 25 * KG) reasons.push("ACTUAL_WEIGHT");
  if (chargeableG > 45 * KG) reasons.push("CHARGEABLE_WEIGHT");
  if (a.quoteOnly) reasons.push("QUOTE_ONLY");

  let sizeClass: SizeClass;
  if (actual > 70 * KG) {
    sizeClass = "QUOTE";
    reasons.push("OVER_70_KG");
  } else if (a.quoteOnly) {
    sizeClass = "QUOTE";
  } else if (a.sizeClassOverride) {
    sizeClass = a.sizeClassOverride;
    reasons.push("OVERRIDE");
  } else if (reasons.length > 0) {
    sizeClass = "QUOTE";
  } else if (longest <= 500 && chargeableG <= 5 * KG) {
    sizeClass = "S";
  } else if (fitsM) {
    sizeClass = "M";
  } else {
    sizeClass = "L";
  }
  return { sizeClass, chargeableG, oversizePiece, nonConveyable, reasons };
}

function maxClass(classes: readonly SizeClass[]): SizeClass {
  return classes.reduce<SizeClass>(
    (acc, c) => (CLASS_ORDER[c] > CLASS_ORDER[acc] ? c : acc),
    "S",
  );
}

/** Surcharges in force on `date` (inclusive Jerusalem calendar days) for `zone`. */
export function activeSurcharges(
  settings: ShippingSettings,
  zone: ZoneId,
  date: Date,
): ShippingSettings["surcharges"] {
  const day = jerusalemDateKey(date);
  return settings.surcharges.filter(
    (s) =>
      s.enabled &&
      (s.zones === "ALL" || s.zones.includes(zone)) &&
      (s.startsOn === null || s.startsOn <= day) &&
      (s.endsOn === null || day <= s.endsOn),
  );
}

interface PiecePrice {
  baseMinor: number;
  pieceFeesMinor: number;
  surchargesMinor: number;
}

/** Price of one classified piece in `zone` (ILS minor units). `null` when the class is QUOTE. */
function piecePrice(
  c: ClassifyResult,
  settings: ShippingSettings,
  zone: ZoneId,
  date: Date,
): PiecePrice | null {
  if (c.sizeClass === "QUOTE") return null;
  const rates = settings.classRatesIls[zone];
  if (!rates) return null;
  const baseMinor = Math.round(rates[c.sizeClass] * 100);
  let pieceFeesMinor = 0;
  if (c.oversizePiece && c.sizeClass !== "L") {
    pieceFeesMinor += Math.round(settings.oversizeFeeIls * 100);
  }
  if (c.nonConveyable) {
    pieceFeesMinor += Math.round(settings.nonConveyableFeeIls * 100);
  }
  let surchargesMinor = 0;
  for (const s of activeSurcharges(settings, zone, date)) {
    surchargesMinor +=
      s.kind === "PCT"
        ? applyBasisPoints(baseMinor, Math.round(s.value * 100))
        : Math.round(s.value * 100);
  }
  return { baseMinor, pieceFeesMinor, surchargesMinor };
}

/**
 * Whether a shipment includes insurance: never for Israel (manual domestic courier), pickup or
 * artist delivery; abroad when insurance is enabled and either a third-party policy covers it or
 * the provider is DHL and the carrier is DHL (or the mock, which simulates DHL).
 */
export function insuranceSupported(
  settings: ShippingSettings,
  method: ShippingMethod,
  zone: ZoneId,
  carrier: CarrierCode | null,
): boolean {
  const ins = settings.insurance;
  if (!ins.enabled || ins.provider === "NONE") return false;
  if (method !== "CARRIER_TABLE" || zone === "IL" || carrier === null) {
    return false;
  }
  if (ins.provider === "THIRD_PARTY") return true;
  return carrier === "DHL" || carrier === "MOCK";
}

/** min(declared, Σ artwork caps when every work has one, settings cap), in ILS minor units. */
export function insuredValueMinor(
  declaredValueIlsMinor: number,
  items: readonly ArtworkShipSpec[],
  settings: ShippingSettings,
): number {
  const caps = items.map((a) => a.maxInsurableValueMinor);
  const artworkCap = caps.every((c) => c !== null)
    ? caps.reduce<number>((s, c) => s + (c ?? 0), 0)
    : Number.POSITIVE_INFINITY;
  const settingsCap = Math.round(settings.insurance.maxInsuredIls * 100);
  return Math.max(0, Math.min(declaredValueIlsMinor, artworkCap, settingsCap));
}

/** max(ratePct × insured value, minIls), rounded half up to the agora. */
export function insurancePremiumMinor(
  insuredMinor: number,
  settings: ShippingSettings,
): number {
  const pctMinor = applyBasisPoints(
    insuredMinor,
    Math.round(settings.insurance.ratePct * 100),
  );
  return Math.max(pctMinor, Math.round(settings.insurance.minIls * 100));
}

function zoneEstimateText(
  settings: ShippingSettings,
  zone: ZoneId,
): { he: string; en: string } | undefined {
  const z = settings.zones.find((x) => x.id === zone);
  return z && (z.estimate.he || z.estimate.en) ? z.estimate : undefined;
}

const NO_PRICE: PiecePrice = {
  baseMinor: 0,
  pieceFeesMinor: 0,
  surchargesMinor: 0,
};

export function quoteShipping(i: QuoteShippingInput): ShippingQuoteResult {
  if (i.items.length === 0) throw new RangeError("no items to ship");
  if (i.country === "IL" && i.currency !== "ILS") {
    throw new RangeError("Israeli destinations are charged in ILS");
  }
  const method: ShippingMethod = i.method ?? "CARRIER_TABLE";
  const { settings } = i;
  const zone = zoneOf(i.country, settings.zones);
  const classes = i.items.map((a) => classify(a, settings.divisor));
  const sizeClass = maxClass(classes.map((c) => c.sizeClass));
  const chargeableG = classes.reduce((s, c) => s + c.chargeableG, 0);
  const domestic = i.country === "IL";
  const usd = i.currency === "USD";

  const build = (
    evaluation: DestinationEvaluation,
    carrier: CarrierCode | null,
    breakdown: PiecePrice,
    insurable: boolean,
  ): ShippingQuoteResult => {
    const shipIls =
      breakdown.baseMinor +
      breakdown.pieceFeesMinor +
      breakdown.surchargesMinor;
    const insuredValue = insurable
      ? insuredValueMinor(i.declaredValueIlsMinor, i.items, settings)
      : 0;
    const insured = insuredValue > 0;
    const insuranceIls = insured
      ? insurancePremiumMinor(insuredValue, settings)
      : 0;
    return {
      ...evaluation,
      zone,
      method,
      carrier,
      sizeClass,
      chargeableG,
      currency: i.currency,
      shippingMinor: usd ? ilsToUsdCeilWhole(shipIls, i.fx.ilsPerUsd) : shipIls,
      insuranceMinor: usd
        ? ilsToUsdCeilWhole(insuranceIls, i.fx.ilsPerUsd)
        : insuranceIls,
      insured,
      insuredValueMinor: insuredValue,
      breakdown,
      ...(usd ? { fxIlsPerUsd: i.fx.ilsPerUsd } : {}),
      ...(method === "CARRIER_TABLE"
        ? { estimate: zoneEstimateText(settings, zone) }
        : {}),
    };
  };
  const refuse = (
    mode: "blocked" | "quote_only",
    reason: BlockReason,
    notices: NoticeCode[] = [],
    carrier: CarrierCode | null = null,
  ) => build({ mode, reason, notices }, carrier, NO_PRICE, false);

  if (method === "QUOTED") return refuse("quote_only", "QUOTE_ONLY");

  if (method === "LOCAL_PICKUP" || method === "ARTIST_DELIVERY") {
    const option =
      method === "LOCAL_PICKUP"
        ? settings.localPickup
        : settings.artistDelivery;
    // Offered only in Israel; a disabled option is reported as ZONE_DISABLED.
    if (!domestic || !option.enabled) return refuse("blocked", "ZONE_DISABLED");
    const fee = Math.round(option.feeIls * 100);
    return build(
      { mode: "ok", notices: [] },
      null,
      { baseMinor: fee, pieceFeesMinor: 0, surchargesMinor: 0 },
      false,
    );
  }

  // CARRIER_TABLE: the manual domestic courier in Israel, the configured carrier abroad.
  const carrier: CarrierCode = domestic ? "MANUAL" : i.carrier;
  const destination = evaluateDestination({
    country: i.country,
    declaredValueIlsMinor: i.declaredValueIlsMinor,
    carrier,
    settings,
    fx: i.fx,
  });
  const notices = [...destination.notices];
  // A local-pickup-only work cannot travel by carrier anywhere; NOT_INTERNATIONAL is reused for it.
  const cannotShip = i.items.some(
    (a) => a.localPickupOnly || (!domestic && !a.shipsInternationally),
  );
  if (destination.mode === "blocked") {
    return refuse(
      "blocked",
      destination.reason ?? "DESTINATION_DENIED",
      notices,
      carrier,
    );
  }
  if (cannotShip) {
    return refuse("blocked", "NOT_INTERNATIONAL", notices, carrier);
  }
  if (destination.mode === "quote_only") {
    return refuse(
      "quote_only",
      destination.reason ?? "QUOTE_ONLY",
      notices,
      carrier,
    );
  }
  if (i.items.some((a) => a.quoteOnly)) {
    return refuse("quote_only", "QUOTE_ONLY", notices, carrier);
  }

  const breakdown = { ...NO_PRICE };
  for (const c of classes) {
    const p = piecePrice(c, settings, zone, i.date);
    if (!p) return refuse("quote_only", "SIZE_QUOTE", notices, carrier);
    breakdown.baseMinor += p.baseMinor;
    breakdown.pieceFeesMinor += p.pieceFeesMinor;
    breakdown.surchargesMinor += p.surchargesMinor;
  }
  if (!domestic) notices.push("TRANSIT_ESTIMATE");
  return build(
    { mode: "ok", notices },
    carrier,
    breakdown,
    insuranceSupported(settings, method, zone, carrier),
  );
}

/**
 * "Delivery from ₪X" per zone for one work (artwork page). `fromIlsMinor` is the carrier-table
 * price on `date` plus, when insured, the minimum premium (the real premium depends on the value);
 * international zones assume the DHL carrier for the insurance flag. A disabled zone, a quote-only
 * work or a QUOTE class → `'QUOTE'`; a work that cannot be shipped there → `'UNAVAILABLE'`.
 * Value caps are not applied (no value here); checkout applies them.
 */
export function zoneEstimates(
  a: ArtworkShipSpec,
  settings: ShippingSettings,
  date: Date,
): Record<ZoneId, ZoneEstimate> {
  const c = classify(a, settings.divisor);
  const out = {} as Record<ZoneId, ZoneEstimate>;
  for (const zone of ZONE_IDS) {
    const cfg = settings.zones.find((z) => z.id === zone);
    const domestic = zone === "IL";
    if (!cfg || a.localPickupOnly || (!domestic && !a.shipsInternationally)) {
      out[zone] = "UNAVAILABLE";
      continue;
    }
    const p = piecePrice(c, settings, zone, date);
    if (!cfg.enabled || a.quoteOnly || !p) {
      out[zone] = "QUOTE";
      continue;
    }
    const insured = insuranceSupported(
      settings,
      "CARRIER_TABLE",
      zone,
      domestic ? "MANUAL" : "DHL",
    );
    out[zone] = {
      fromIlsMinor:
        p.baseMinor +
        p.pieceFeesMinor +
        p.surchargesMinor +
        (insured ? Math.round(settings.insurance.minIls * 100) : 0),
      insured,
    };
  }
  return out;
}
