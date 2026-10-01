import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { ShippingSettings } from "@/server/settings/schemas";
import type {
  ArtworkShipSpec,
  ClassifyResult,
  QuoteShippingInput,
  ShippingQuoteResult,
  ZoneEstimate,
  ZoneId,
} from "./types";

/**
 * The pure rate engine (spec §4.4 "Rate engine"; frozen signatures). Classes use packed dimensions
 * sorted L ≥ W ≥ H (`sortedDims`, `chargeableWeightG` in `@/lib/dimensions`); a per-artwork
 * override wins; insurance is capped before the premium; USD converts once and rounds up to whole
 * dollars (`ilsToUsdCeilWhole`). Bodies: M2 (IL + international basics), then WS3.
 */
export function classify(_a: ArtworkShipSpec, _divisor = 5000): ClassifyResult {
  return notImplemented("shipping classify", "M2/WS3");
}

export function quoteShipping(_i: QuoteShippingInput): ShippingQuoteResult {
  return notImplemented("shipping quoteShipping", "M2/WS3");
}

export function zoneEstimates(
  _a: ArtworkShipSpec,
  _settings: ShippingSettings,
  _date: Date,
): Record<ZoneId, ZoneEstimate> {
  return notImplemented("shipping zoneEstimates", "M2/WS3");
}
