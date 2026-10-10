import "server-only";
import { COUNTRY_CODES, ZONE_IDS, zoneOf } from "@/lib/countries";
import { chargeableWeightG, sortedDims } from "@/lib/dimensions";
import { jerusalemDateKey } from "@/lib/format";
import { applyBasisPoints, ilsToUsdCeilWhole } from "@/lib/money";
import type { ShippingSettings } from "@/server/settings/schemas";
import { declaredValueUsdMinor, exportDeclarationRequired } from "./customs";
import {
  type DhlPieceInput,
  dhlEstimate,
  dhlPriceKey,
  dhlZoneOf,
} from "./dhl-estimate";
import {
  emsGroupOf,
  emsInsurance,
  israelPostEstimate,
  type PostPieceInput,
} from "./israel-post";
import { evaluateDestination } from "./rules";
import type {
  ArtworkShipSpec,
  BlockReason,
  CarrierCode,
  ClassifyResult,
  DestinationEvaluation,
  DhlEstimateDetail,
  FxReference,
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
 * 260 × 260 mm. A work listed as a tube uses the stored `packed_weight_g`. A boxed work the buyer
 * asks to have rolled (`rolledSpec`, for works `rollableAtCheckout`) is priced as that tube with
 * the assumed rolled weight (`rolledWeightG`: no stretcher bars, no box).
 *
 * Price per piece = `classRatesIls[zone][class]` + per-piece fees + active surcharges (`enabled`
 * and `startsOn ≤ date ≤ endsOn`, inclusive Jerusalem calendar days; PCT of the base class rate or
 * FIXED ILS per piece; `ALL` or listed zones). Insurance on the order: insuredValue =
 * min(declared, Σ artwork caps (when every work has one), `maxInsuredIls`), premium =
 * max(ratePct × insuredValue, `minIls`), only when `insurance.enabled` and the carrier or method
 * supports it. USD converts shipping and insurance once with `fx.ilsPerUsd`, each rounded up to
 * whole dollars; `breakdown` stays in ILS minor units.
 *
 * Abroad, `CARRIER_TABLE` is priced by the DHL Express estimate instead of the table
 * (`dhl-estimate.ts`: DHL's published Israel tariff for the whole order as one multi-piece
 * shipment) when `dhlEstimate.enabled` and the guide lists the destination; the table stays for
 * Israel and as the fallback (estimate disabled, destination without a DHL zone). On that path a
 * piece needs a quote only for what DHL's tariff cannot settle (`dhlPriceable`: crate, glazing,
 * an unrollable tube, `quote_only`, over 70 kg actual, an override to QUOTE, or beyond DHL's
 * piece and shipment limits); the table's weight limits do not apply. `breakdown` = net
 * transport / piece surcharges / everything else, and the quote carries `rateSource` and `dhl`.
 */

export const TUBE_EXTRA_MM = 100;
export const TUBE_SECTION_MM = 260;
/**
 * Assumed weight of a canvas rolled off its stretcher, in its tube: 1.5 kg for the tube and the
 * wrapping, plus 1.2 kg per m² of painted canvas. An assumption until the painter weighs one.
 */
export const ROLLED_BASE_G = 1500;
export const ROLLED_G_PER_M2 = 1200;
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

/** A rolled canvas in its tube (`ROLLED_BASE_G` + `ROLLED_G_PER_M2` × the painting's area). */
export function rolledWeightG(a: {
  heightMm: number;
  widthMm: number;
}): number {
  const areaM2 = (a.heightMm / 1000) * (a.widthMm / 1000);
  return Math.round(ROLLED_BASE_G + ROLLED_G_PER_M2 * areaM2);
}

/**
 * Whether the buyer may have the work rolled in a tube instead of sent as listed: the painter
 * allows it (`can_be_rolled`), it is not already a tube, and nothing rigid comes with it (no
 * crate, frame or glazing).
 */
export function rollableAtCheckout(a: ArtworkShipSpec): boolean {
  return (
    a.canBeRolled &&
    !a.framed &&
    a.glazing === "NONE" &&
    a.packagingType !== "ROLLED_TUBE" &&
    a.packagingType !== "CRATE" &&
    a.packagingType !== "FRAMED_BOX"
  );
}

/**
 * The work rolled in a tube, as the buyer may choose at checkout: the tube's size, the rolled
 * weight, and no class override (the override was set for the box).
 */
export function rolledSpec(a: ArtworkShipSpec): ArtworkShipSpec {
  const tube = rolledTubeBox(a);
  return {
    ...a,
    packagingType: "ROLLED_TUBE",
    canBeRolled: true,
    packedLengthMm: tube.lengthMm,
    packedWidthMm: tube.widthMm,
    packedHeightMm: tube.heightMm,
    packedWeightG: rolledWeightG(a),
    sizeClassOverride: null,
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

const WEIGHT_REASONS: ReadonlySet<string> = new Set([
  "ACTUAL_WEIGHT",
  "CHARGEABLE_WEIGHT",
]);

/**
 * Whether DHL's tariff can price a classified piece: an S/M/L class (an override included), or a
 * QUOTE caused only by the table's weight limits (≥ 25 kg actual, > 45 kg chargeable), which the
 * tariff prices itself.
 */
export function dhlPriceable(c: ClassifyResult): boolean {
  if (c.sizeClass !== "QUOTE") return true;
  return c.reasons.length > 0 && c.reasons.every((r) => WEIGHT_REASONS.has(r));
}

/** A packed artwork as DHL measures it; a crate and a round tube are Non-Conveyable. */
export function dhlPieceOf(a: ArtworkShipSpec): DhlPieceInput {
  const box = packedBox(a);
  return {
    lengthMm: box.lengthMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    weightG: a.packedWeightG,
    nonConveyablePackaging:
      a.packagingType === "CRATE" ||
      (a.packagingType === "ROLLED_TUBE" && a.canBeRolled),
  };
}

/** Israel Post takes ordinary cardboard parcels: no wooden crate and no glazing. */
function postParcelOk(a: ArtworkShipSpec): boolean {
  return a.packagingType !== "CRATE" && a.glazing === "NONE";
}

/** A packed artwork as Israel Post measures it (the box `packedBox` gives, its actual weight). */
export function postPieceOf(a: ArtworkShipSpec): PostPieceInput {
  const box = packedBox(a);
  return {
    lengthMm: box.lengthMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    weightG: a.packedWeightG,
  };
}

/** The export declaration is required: the same rule fulfilment applies (`customs.ts`). */
function exportDeclarationDue(
  valueIlsMinor: number,
  settings: ShippingSettings,
  fx: FxReference,
): boolean {
  return exportDeclarationRequired(
    declaredValueUsdMinor(valueIlsMinor, "ILS", fx.ilsPerUsd),
    settings.thresholds.exportDeclarationUsd,
  );
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
 * Whether a shipment includes insurance: never for Israel (manual domestic courier) or pickup;
 * abroad when insurance is enabled and either a third-party policy covers it or the provider is
 * DHL and the carrier is DHL (or the mock, which simulates DHL).
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

/** A DHL estimate in the frozen breakdown: net transport / piece surcharges / the rest. */
function dhlBreakdown(d: DhlEstimateDetail): PiecePrice {
  return {
    baseMinor: d.transportNetMinor,
    pieceFeesMinor: d.pieceSurchargesMinor,
    surchargesMinor:
      d.totalMinor - d.transportNetMinor - d.pieceSurchargesMinor,
  };
}

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

  /**
   * `insurance`: true = the settings' insurance on the capped value; false = none; or an explicit
   * covered value and premium (Israel Post's EMS liability extension).
   */
  const build = (
    evaluation: DestinationEvaluation,
    carrier: CarrierCode | null,
    breakdown: PiecePrice,
    insurance: boolean | { valueMinor: number; premiumMinor: number },
    extra: Pick<
      ShippingQuoteResult,
      "rateSource" | "dhl" | "israelPost" | "estimate"
    > = {},
  ): ShippingQuoteResult => {
    const shipIls =
      breakdown.baseMinor +
      breakdown.pieceFeesMinor +
      breakdown.surchargesMinor;
    const insuredValue =
      insurance === true
        ? insuredValueMinor(i.declaredValueIlsMinor, i.items, settings)
        : insurance === false
          ? 0
          : insurance.valueMinor;
    const insured = insuredValue > 0;
    const insuranceIls = !insured
      ? 0
      : insurance === true
        ? insurancePremiumMinor(insuredValue, settings)
        : insurance === false
          ? 0
          : insurance.premiumMinor;
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
      ...extra,
    };
  };
  const refuse = (
    mode: "blocked" | "quote_only",
    reason: BlockReason,
    notices: NoticeCode[] = [],
    carrier: CarrierCode | null = null,
  ) => build({ mode, reason, notices }, carrier, NO_PRICE, false);

  if (method === "QUOTED") return refuse("quote_only", "QUOTE_ONLY");

  if (method === "LOCAL_PICKUP") {
    const option = settings.localPickup;
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

  const post = settings.israelPost;
  if (method === "ISRAEL_POST" && !(domestic ? post.domestic : post.abroad)) {
    return refuse("blocked", "ZONE_DISABLED");
  }

  // CARRIER_TABLE: the manual domestic courier in Israel, the configured carrier abroad.
  // ISRAEL_POST: booked at the post office and tracked by hand (the manual carrier).
  const carrier: CarrierCode =
    domestic || method === "ISRAEL_POST" ? "MANUAL" : i.carrier;
  const destination = evaluateDestination({
    country: i.country,
    declaredValueIlsMinor: i.declaredValueIlsMinor,
    carrier,
    settings,
    fx: i.fx,
  });
  const notices = destination.notices.filter(
    (n) => n !== "EU_LOW_VALUE_DUTY" || euLowValueDutyActive(i.date),
  );
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

  if (method === "ISRAEL_POST") {
    // Israel Post takes ordinary cardboard parcels: no wooden crate, no glazing.
    if (i.items.some((a) => !postParcelOk(a))) {
      return refuse("blocked", "SIZE_QUOTE", notices, carrier);
    }
    const est = israelPostEstimate({
      pieces: i.items.map(postPieceOf),
      country: i.country,
    });
    if (!est.ok) {
      return refuse(
        "blocked",
        est.reason === "NOT_SERVED" ? "ZONE_DISABLED" : "SIZE_QUOTE",
        notices,
        carrier,
      );
    }
    if (!domestic) notices.push("TRANSIT_ESTIMATE");
    const insure = !domestic && post.insureAbroad && settings.insurance.enabled;
    return build(
      { mode: "ok", notices },
      carrier,
      {
        baseMinor: est.detail.totalMinor,
        pieceFeesMinor: 0,
        surchargesMinor: 0,
      },
      insure
        ? emsInsurance(
            insuredValueMinor(i.declaredValueIlsMinor, i.items, settings),
          )
        : false,
      {
        rateSource: "ISRAEL_POST",
        israelPost: est.detail,
        estimate: domestic ? post.estimate.domestic : post.estimate.abroad,
      },
    );
  }

  if (
    !domestic &&
    settings.dhlEstimate.enabled &&
    dhlZoneOf(i.country, i.date) !== null
  ) {
    if (!classes.every(dhlPriceable)) {
      return refuse("quote_only", "SIZE_QUOTE", notices, carrier);
    }
    const est = dhlEstimate({
      pieces: i.items.map(dhlPieceOf),
      country: i.country,
      date: i.date,
      settings: settings.dhlEstimate,
      exportDeclaration: exportDeclarationDue(
        i.declaredValueIlsMinor,
        settings,
        i.fx,
      ),
    });
    // Beyond DHL's piece or shipment limits: DHL would refuse it, so it is a quote.
    if (!est.ok) return refuse("quote_only", "SIZE_QUOTE", notices, carrier);
    notices.push("TRANSIT_ESTIMATE");
    return build(
      { mode: "ok", notices },
      carrier,
      dhlBreakdown(est.detail),
      insuranceSupported(settings, method, zone, carrier),
      { rateSource: "DHL_ESTIMATE", dhl: est.detail },
    );
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
    { rateSource: "TABLE" },
  );
}

/**
 * The temporary EUR 3 EU duty on low-value parcels applies from 2026-07-01 to 2028-07-01
 * (inclusive Jerusalem calendar days). `evaluateDestination` has no date, so `quoteShipping`
 * drops the notice outside the window.
 */
export const EU_LOW_VALUE_DUTY_WINDOW = {
  startsOn: "2026-07-01",
  endsOn: "2028-07-01",
} as const;

export function euLowValueDutyActive(date: Date): boolean {
  const day = jerusalemDateKey(date);
  return (
    EU_LOW_VALUE_DUTY_WINDOW.startsOn <= day &&
    day <= EU_LOW_VALUE_DUTY_WINDOW.endsOn
  );
}

/**
 * The insured value in the order currency, for "insured up to …" copy. The quote stores it in
 * ILS minor units; a USD order shows it in USD, rounded **down** to whole dollars (the cover is
 * never overstated) with the quote's locked rate. 0 when the quote is uninsured.
 */
export function insuredValueInCurrency(
  q: Pick<
    ShippingQuoteResult,
    "insured" | "insuredValueMinor" | "currency" | "fxIlsPerUsd"
  >,
): number {
  if (!q.insured || q.insuredValueMinor <= 0) return 0;
  if (q.currency === "ILS") return q.insuredValueMinor;
  if (!q.fxIlsPerUsd) return 0;
  const rateMicro = BigInt(Math.round(q.fxIlsPerUsd * 1_000_000));
  const dollars =
    (BigInt(q.insuredValueMinor) * 1_000_000n) / (rateMicro * 100n);
  return Number(dollars * 100n);
}

/**
 * The cheapest DHL estimate for one work among the countries of a site zone that DHL's guide lists
 * (and that are offered: not denied, not quote-only). Null when the zone has no such country (the
 * table applies); `"QUOTE"` when DHL's tariff cannot price the piece.
 */
function dhlFromIlsMinor(
  a: ArtworkShipSpec,
  c: ClassifyResult,
  settings: ShippingSettings,
  zone: ZoneId,
  date: Date,
  exportDeclaration: boolean,
): number | "QUOTE" | null {
  // One country per group that costs the same (zone, demand region, per-shipment surcharges).
  const byKey = new Map<string, string>();
  for (const code of COUNTRY_CODES) {
    if (
      code === "IL" ||
      settings.deniedCountries.includes(code) ||
      settings.quoteOnlyCountries.includes(code) ||
      zoneOf(code, settings.zones) !== zone
    ) {
      continue;
    }
    const key = dhlPriceKey(code, date);
    if (key !== null && !byKey.has(key)) byKey.set(key, code);
  }
  if (byKey.size === 0) return null;
  if (!dhlPriceable(c)) return "QUOTE";
  const pieces = [dhlPieceOf(a)];
  let best: number | null = null;
  for (const country of byKey.values()) {
    const est = dhlEstimate({
      pieces,
      country,
      date,
      settings: settings.dhlEstimate,
      exportDeclaration,
    });
    if (!est.ok) return "QUOTE";
    if (best === null || est.detail.totalMinor < best) {
      best = est.detail.totalMinor;
    }
  }
  return best;
}

/**
 * Israel Post's cheapest price for one work in a site zone: home delivery in Israel, or the
 * cheapest EMS destination of the zone where the parcel fits (offered countries only), plus the
 * EMS liability extension when it applies (`value` gives the work's value; without it, the
 * minimum), with Israel Post's delivery time. Null when Israel Post cannot take it there.
 */
function postFromIlsMinor(
  a: ArtworkShipSpec,
  settings: ShippingSettings,
  zone: ZoneId,
  value?: { declaredValueIlsMinor: number; fx: FxReference },
): Exclude<ZoneEstimate, string> | null {
  const post = settings.israelPost;
  if (a.quoteOnly || !postParcelOk(a)) return null;
  const pieces = [postPieceOf(a)];
  if (zone === "IL") {
    if (!post.domestic) return null;
    const est = israelPostEstimate({ pieces, country: "IL" });
    return est.ok
      ? {
          fromIlsMinor: est.detail.totalMinor,
          insured: false,
          estimate: post.estimate.domestic,
        }
      : null;
  }
  if (!post.abroad) return null;
  // One country per (EMS group, size limit): they cost the same.
  const tried = new Set<string>();
  let best: number | null = null;
  for (const code of COUNTRY_CODES) {
    if (
      code === "IL" ||
      settings.deniedCountries.includes(code) ||
      settings.quoteOnlyCountries.includes(code) ||
      zoneOf(code, settings.zones) !== zone
    ) {
      continue;
    }
    const group = emsGroupOf(code);
    if (group === null) continue;
    const est = israelPostEstimate({ pieces, country: code });
    const key = `${group}|${est.ok ? "fits" : est.reason}`;
    if (tried.has(key)) continue;
    tried.add(key);
    if (est.ok && (best === null || est.detail.totalMinor < best)) {
      best = est.detail.totalMinor;
    }
  }
  if (best === null) return null;
  const insured = post.insureAbroad && settings.insurance.enabled;
  const premium = !insured
    ? 0
    : value
      ? emsInsurance(
          insuredValueMinor(value.declaredValueIlsMinor, [a], settings),
        ).premiumMinor
      : emsInsurance(1).premiumMinor;
  return {
    fromIlsMinor: best + premium,
    insured,
    estimate: post.estimate.abroad,
  };
}

/**
 * "Delivery from ₪X" per zone for one work (artwork page): the cheaper of the courier and Israel
 * Post (`postFromIlsMinor`, which also gives Israel Post's delivery time), as listed and, when the
 * buyer may choose it (`rollableAtCheckout`), rolled in a tube (`rolled: true`). The courier is the table in Israel and, abroad, the cheapest DHL
 * estimate among the zone's listed countries (`dhlFromIlsMinor`; the table when none is listed or
 * the estimate is off), plus the minimum premium when insured (international zones assume the
 * DHL carrier for the insurance flag); `value` adds the export declaration when it is due. A
 * zone closed to online ordering still gets its estimate (ordering there is by quote); a
 * quote-only work → `'QUOTE'`; a piece only a quote can price → `'QUOTE'`
 * unless Israel Post takes it; a work that cannot be shipped there → `'UNAVAILABLE'`. Value caps
 * are not applied; checkout applies them.
 */
export function zoneEstimates(
  a: ArtworkShipSpec,
  settings: ShippingSettings,
  date: Date,
  value?: { declaredValueIlsMinor: number; fx: FxReference },
): Record<ZoneId, ZoneEstimate> {
  const exportDeclaration = value
    ? exportDeclarationDue(value.declaredValueIlsMinor, settings, value.fx)
    : false;
  // As listed, and rolled in a tube when the buyer may choose it (stretched wins a tie).
  const variants = [{ spec: a, rolled: false }];
  if (rollableAtCheckout(a))
    variants.push({ spec: rolledSpec(a), rolled: true });
  const classified = variants.map((v) => ({
    ...v,
    c: classify(v.spec, settings.divisor),
  }));
  const out = {} as Record<ZoneId, ZoneEstimate>;
  for (const zone of ZONE_IDS) {
    const cfg = settings.zones.find((z) => z.id === zone);
    const domestic = zone === "IL";
    if (!cfg || a.localPickupOnly || (!domestic && !a.shipsInternationally)) {
      out[zone] = "UNAVAILABLE";
      continue;
    }
    // A zone closed to online ordering (EUROPE by default) still shows its estimate; there the
    // buyer asks for a quote (`rules.ts`: ZONE_DISABLED).
    if (a.quoteOnly) {
      out[zone] = "QUOTE";
      continue;
    }
    const candidates = classified.flatMap((v) =>
      zoneCandidates(
        v.spec,
        v.c,
        settings,
        zone,
        date,
        value,
        exportDeclaration,
      ).map((x) => (v.rolled ? { ...x, rolled: true } : x)),
    );
    const best = candidates.reduce<(typeof candidates)[number] | null>(
      (m, x) => (m === null || x.fromIlsMinor < m.fromIlsMinor ? x : m),
      null,
    );
    out[zone] = best ?? "QUOTE";
  }
  return out;
}

/** One packing's "from" prices in a zone: the courier (DHL estimate or table) and Israel Post. */
function zoneCandidates(
  a: ArtworkShipSpec,
  c: ClassifyResult,
  settings: ShippingSettings,
  zone: ZoneId,
  date: Date,
  value: { declaredValueIlsMinor: number; fx: FxReference } | undefined,
  exportDeclaration: boolean,
): Exclude<ZoneEstimate, string>[] {
  const domestic = zone === "IL";
  const candidates: Exclude<ZoneEstimate, string>[] = [];
  const dhl =
    !domestic && settings.dhlEstimate.enabled
      ? dhlFromIlsMinor(a, c, settings, zone, date, exportDeclaration)
      : null;
  let courierMinor: number | null = null;
  if (typeof dhl === "number") {
    courierMinor = dhl;
  } else if (dhl === null) {
    const p = piecePrice(c, settings, zone, date);
    if (p) courierMinor = p.baseMinor + p.pieceFeesMinor + p.surchargesMinor;
  }
  if (courierMinor !== null) {
    const insured = insuranceSupported(
      settings,
      "CARRIER_TABLE",
      zone,
      domestic ? "MANUAL" : "DHL",
    );
    candidates.push({
      fromIlsMinor:
        courierMinor +
        (insured ? Math.round(settings.insurance.minIls * 100) : 0),
      insured,
    });
  }
  const post = postFromIlsMinor(a, settings, zone, value);
  if (post) candidates.push(post);
  return candidates;
}
