import "server-only";
import type { Currency } from "@/lib/money";
import { type ActiveSale, activeSale, applySale } from "@/lib/sale";
import { vatForOrder } from "@/lib/vat";
import type { CheckoutSettings, ShippingSettings } from "@/server/settings";
import {
  insuredValueInCurrency,
  quoteShipping,
  rollableAtCheckout,
  rolledSpec,
} from "@/server/shipping/rates";
import type {
  ArtworkShipSpec,
  CarrierCode,
  FxReference,
  Packing,
  ShippingMethod,
  ShippingQuoteResult,
} from "@/server/shipping/types";
import type { LockedArtwork } from "./reservations";

/**
 * Checkout pricing (spec §2.3 `checkout/pricing.ts`, §6.5): item prices per currency, the shipping
 * engine input of an artwork row, and the order amounts (items + shipping + insurance, VAT
 * snapshot). Pure. IL destinations always pay in ILS (also a DB CHECK).
 */
export type PricedArtwork = Pick<
  LockedArtwork,
  | "id"
  | "priceIlsMinor"
  | "priceUsdMinor"
  | "priceOnRequest"
  | "declaredValueOverrideMinor"
  | "heightMm"
  | "widthMm"
  | "depthMm"
  | "packagingType"
  | "canBeRolled"
  | "packedLengthMm"
  | "packedWidthMm"
  | "packedHeightMm"
  | "packedWeightG"
  | "sizeClassOverride"
  | "glazing"
  | "framed"
  | "shipsInternationally"
  | "localPickupOnly"
  | "quoteOnly"
  | "maxInsurableValueMinor"
  | "dispatchDays"
>;

/** Engine input for one artwork (packed defaults follow `catalog/queries.ts#getArtworkPage`). */
export function shipSpecOf(a: PricedArtwork): ArtworkShipSpec {
  return {
    artworkId: a.id,
    heightMm: a.heightMm,
    widthMm: a.widthMm,
    depthMm: a.depthMm,
    packagingType: a.packagingType,
    canBeRolled: a.canBeRolled,
    packedLengthMm: a.packedLengthMm ?? a.heightMm + 120,
    packedWidthMm: a.packedWidthMm ?? a.widthMm + 120,
    packedHeightMm: a.packedHeightMm ?? (a.depthMm ?? 30) + 80,
    packedWeightG: a.packedWeightG ?? 5000,
    sizeClassOverride: a.sizeClassOverride,
    glazing: a.glazing,
    framed: a.framed,
    shipsInternationally: a.shipsInternationally,
    localPickupOnly: a.localPickupOnly,
    quoteOnly: a.quoteOnly,
    maxInsurableValueMinor: a.maxInsurableValueMinor,
    dispatchDays: a.dispatchDays,
  };
}

/**
 * The price charged in `currency` (the list price, less the running sale when given), or null when
 * the work has no price in it.
 */
export function itemPriceMinor(
  a: PricedArtwork,
  currency: Currency,
  sale: ActiveSale | null = null,
): number | null {
  if (a.priceOnRequest) return null;
  return applySale(
    currency === "ILS" ? a.priceIlsMinor : a.priceUsdMinor,
    sale,
    a.id,
  );
}

/** Declared value for customs and insurance, in ILS minor units: the price actually paid. */
export function declaredValueIlsMinor(
  a: PricedArtwork,
  sale: ActiveSale | null = null,
): number {
  return (
    a.declaredValueOverrideMinor ?? applySale(a.priceIlsMinor, sale, a.id) ?? 0
  );
}

export function fxReference(s: CheckoutSettings): FxReference {
  return {
    ilsPerUsd: s.fx.ilsPerUsd,
    ilsPerEur: s.fx.ilsPerEur,
    ilsPerGbp: s.fx.ilsPerGbp,
    asOf: s.fx.asOf,
  };
}

/**
 * Methods offered for a destination, in display order (the first available one is preselected):
 * the courier, Israel Post (when the parcel fits its limits), then pickup from the studio in
 * Israel.
 */
export function candidateMethods(country: string): ShippingMethod[] {
  return country === "IL"
    ? ["CARRIER_TABLE", "ISRAEL_POST", "LOCAL_PICKUP"]
    : ["CARRIER_TABLE", "ISRAEL_POST"];
}

export interface ShippingOptions {
  /** Every candidate method's quote (ok or not). */
  all: ShippingQuoteResult[];
  /** The quotes the buyer can pick. */
  ok: ShippingQuoteResult[];
}

/** Whether the buyer can have any of the works rolled in a tube (the checkout's packing choice). */
export function anyRollable(items: readonly PricedArtwork[]): boolean {
  return items.some((a) => rollableAtCheckout(shipSpecOf(a)));
}

/**
 * Every candidate method's quote. `packing: "ROLLED"` prices the works the buyer may have rolled
 * as tubes (`rolledSpec`; the others as listed), and the quotes then carry `packing: "ROLLED"`.
 */
export function shippingOptions(i: {
  items: PricedArtwork[];
  country: string;
  currency: Currency;
  date: Date;
  shipping: ShippingSettings;
  checkout: CheckoutSettings;
  carrier: CarrierCode;
  packing?: Packing;
}): ShippingOptions {
  const listed = i.items.map(shipSpecOf);
  const rolled = i.packing === "ROLLED" && listed.some(rollableAtCheckout);
  const specs = rolled
    ? listed.map((s) => (rollableAtCheckout(s) ? rolledSpec(s) : s))
    : listed;
  const sale = activeSale(i.checkout.sale, i.date);
  const declared = i.items.reduce(
    (s, a) => s + declaredValueIlsMinor(a, sale),
    0,
  );
  const all = candidateMethods(i.country).map((method) => {
    const q = quoteShipping({
      items: specs,
      country: i.country,
      method,
      currency: i.currency,
      date: i.date,
      declaredValueIlsMinor: declared,
      settings: i.shipping,
      fx: fxReference(i.checkout),
      carrier: i.carrier,
    });
    return rolled ? { ...q, packing: "ROLLED" as const } : q;
  });
  return { all, ok: all.filter((q) => q.mode === "ok") };
}

export interface OrderAmounts {
  itemsTotalMinor: number;
  shippingMinor: number;
  insuranceMinor: number;
  totalMinor: number;
  vatRateBp: number;
  vatMinor: number;
}

export function orderAmounts(i: {
  itemsTotalMinor: number;
  quote: Pick<ShippingQuoteResult, "shippingMinor" | "insuranceMinor">;
  vatMode: "OSEK_PATUR" | "OSEK_MURSHE";
  country: string;
  date: Date;
}): OrderAmounts {
  const totalMinor =
    i.itemsTotalMinor + i.quote.shippingMinor + i.quote.insuranceMinor;
  const vat = vatForOrder({
    vatMode: i.vatMode,
    zeroRatedExport: i.country !== "IL",
    totalMinor,
    date: i.date,
  });
  return {
    itemsTotalMinor: i.itemsTotalMinor,
    shippingMinor: i.quote.shippingMinor,
    insuranceMinor: i.quote.insuranceMinor,
    totalMinor,
    vatRateBp: vat.rateBp,
    vatMinor: vat.vatMinor,
  };
}

/**
 * The insured value shown to the buyer, in the order currency (M2 open item: a USD checkout said
 * "insured up to ₪5,800"). The engine caps the insured value in ILS minor units; for USD it is
 * converted by WS3's `rates.ts#insuredValueInCurrency` (the conversion the DHL label declares:
 * the quote's locked rate, rounded **down** to whole dollars in exact integer arithmetic), so the
 * page never promises more cover than the ILS cap or than the label insures.
 */
export function insuredValueForDisplay(
  quote: Pick<ShippingQuoteResult, "insuredValueMinor" | "fxIlsPerUsd">,
  currency: Currency,
  fallbackIlsPerUsd: number,
): number {
  return insuredValueInCurrency({
    insured: quote.insuredValueMinor > 0,
    insuredValueMinor: quote.insuredValueMinor,
    currency,
    fxIlsPerUsd: quote.fxIlsPerUsd ?? fallbackIlsPerUsd,
  });
}
