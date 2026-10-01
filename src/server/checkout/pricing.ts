import "server-only";
import type { Currency } from "@/lib/money";
import { vatForOrder } from "@/lib/vat";
import type { CheckoutSettings, ShippingSettings } from "@/server/settings";
import { quoteShipping } from "@/server/shipping/rates";
import type {
  ArtworkShipSpec,
  CarrierCode,
  FxReference,
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

/** The list price in `currency`, or null when the work has no price in it. */
export function itemPriceMinor(
  a: PricedArtwork,
  currency: Currency,
): number | null {
  if (a.priceOnRequest) return null;
  return currency === "ILS" ? a.priceIlsMinor : a.priceUsdMinor;
}

/** Declared value for customs and insurance, in ILS minor units. */
export function declaredValueIlsMinor(a: PricedArtwork): number {
  return a.declaredValueOverrideMinor ?? a.priceIlsMinor ?? 0;
}

export function fxReference(s: CheckoutSettings): FxReference {
  return {
    ilsPerUsd: s.fx.ilsPerUsd,
    ilsPerEur: s.fx.ilsPerEur,
    ilsPerGbp: s.fx.ilsPerGbp,
    asOf: s.fx.asOf,
  };
}

/** Methods offered for a destination, in display order. */
export function candidateMethods(country: string): ShippingMethod[] {
  return country === "IL"
    ? ["CARRIER_TABLE", "LOCAL_PICKUP", "ARTIST_DELIVERY"]
    : ["CARRIER_TABLE"];
}

export interface ShippingOptions {
  /** Every candidate method's quote (ok or not). */
  all: ShippingQuoteResult[];
  /** The quotes the buyer can pick. */
  ok: ShippingQuoteResult[];
}

export function shippingOptions(i: {
  items: PricedArtwork[];
  country: string;
  currency: Currency;
  date: Date;
  shipping: ShippingSettings;
  checkout: CheckoutSettings;
  carrier: CarrierCode;
}): ShippingOptions {
  const specs = i.items.map(shipSpecOf);
  const declared = i.items.reduce((s, a) => s + declaredValueIlsMinor(a), 0);
  const all = candidateMethods(i.country).map((method) =>
    quoteShipping({
      items: specs,
      country: i.country,
      method,
      currency: i.currency,
      date: i.date,
      declaredValueIlsMinor: declared,
      settings: i.shipping,
      fx: fxReference(i.checkout),
      carrier: i.carrier,
    }),
  );
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
 * converted with the quote's locked rate and rounded **down** to whole dollars, so the page never
 * promises more cover than the ILS cap.
 */
export function insuredValueForDisplay(
  quote: Pick<ShippingQuoteResult, "insuredValueMinor" | "fxIlsPerUsd">,
  currency: Currency,
  fallbackIlsPerUsd: number,
): number {
  if (currency === "ILS") return quote.insuredValueMinor;
  const rate = quote.fxIlsPerUsd ?? fallbackIlsPerUsd;
  if (!(rate > 0) || quote.insuredValueMinor <= 0) return 0;
  return Math.floor(quote.insuredValueMinor / 100 / rate) * 100;
}
