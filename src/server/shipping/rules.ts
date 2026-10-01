import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { ShippingSettings } from "@/server/settings/schemas";
import type { CarrierCode, DestinationEvaluation, FxReference } from "./types";

/**
 * Country rules (spec §4.4 "Country rules"; frozen signature): deny list, quote-only countries,
 * disabled zones, NOT_INTERNATIONAL, GB ≤ GBP 135, carrier value caps, and the DAP / EU / US
 * notices. Zone lookup: `zoneOf` in `@/lib/countries`. Body: M2, then WS3.
 */
export function evaluateDestination(_i: {
  country: string;
  declaredValueIlsMinor: number;
  carrier: CarrierCode;
  settings: ShippingSettings;
  fx: FxReference;
}): DestinationEvaluation {
  return notImplemented("shipping evaluateDestination", "M2/WS3");
}
