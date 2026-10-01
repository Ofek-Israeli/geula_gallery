import "server-only";
import { isEuCountry, zoneOf } from "@/lib/countries";
import { toIlsMinor, usdToIls } from "@/lib/money";
import { nonLatinFields } from "@/lib/script";
import type { ShippingSettings } from "@/server/settings/schemas";
import type {
  CarrierCode,
  DestinationEvaluation,
  FxReference,
  NoticeCode,
} from "./types";

/**
 * Country rules (spec §4.4 "Country rules"; frozen signature). Pure.
 *
 * Order of evaluation (the strongest outcome wins):
 * 1. deny list → `blocked` DESTINATION_DENIED (the painter may remove IQ from `deniedCountries`);
 * 2. Israel → `ok`, no notices;
 * 3. GB (incl. Northern Ireland) with a declared value ≤ GBP 135 → `blocked` GB_LOW_VALUE (UK VAT
 *    would have to be collected at the point of sale);
 * 4. `quoteOnlyCountries` → `quote_only` QUOTE_ONLY;
 * 5. a disabled zone (EUROPE by default) → `quote_only` ZONE_DISABLED;
 * 6. a declared value above the carrier's cap (`valueCaps`, DHL USD 2,500) → `quote_only` VALUE_CAP.
 *
 * Notices for every international destination, whatever the mode: DAP_DUTIES; EU ≤ EUR 150 →
 * EU_LOW_VALUE_DUTY (the temporary EUR 3 duty, 2026-07-01 to 2028-07-01; the signature has no date,
 * so the copy carries the dates); US → US_DUTY_FREE_CLEARANCE_FEES, and above USD 2,500 also
 * US_FORMAL_ENTRY. NOT_INTERNATIONAL, QUOTE_ONLY (per work) and SIZE_QUOTE depend on the works and
 * are applied by `quoteShipping` / `zoneEstimates` in `rates.ts`.
 *
 * Threshold comparisons convert the threshold to ILS minor units with the dated reference rate
 * (exact integer maths), never the declared value to a float.
 */
export function evaluateDestination(i: {
  country: string;
  declaredValueIlsMinor: number;
  carrier: CarrierCode;
  settings: ShippingSettings;
  fx: FxReference;
}): DestinationEvaluation {
  const { country, declaredValueIlsMinor: value, settings, fx } = i;
  if (settings.deniedCountries.includes(country)) {
    return { mode: "blocked", reason: "DESTINATION_DENIED", notices: [] };
  }
  if (country === "IL") return { mode: "ok", notices: [] };

  const t = settings.thresholds;
  const notices: NoticeCode[] = ["DAP_DUTIES"];
  if (
    isEuCountry(country) &&
    value <= toIlsMinor(Math.round(t.euLowValueEur * 100), fx.ilsPerEur)
  ) {
    notices.push("EU_LOW_VALUE_DUTY");
  }
  if (country === "US") {
    notices.push("US_DUTY_FREE_CLEARANCE_FEES");
    if (value > usdToIls(Math.round(t.usFormalEntryUsd * 100), fx.ilsPerUsd)) {
      notices.push("US_FORMAL_ENTRY");
    }
  }

  if (
    country === "GB" &&
    value <= toIlsMinor(Math.round(t.gbLowValueGbp * 100), fx.ilsPerGbp)
  ) {
    return { mode: "blocked", reason: "GB_LOW_VALUE", notices };
  }
  if (settings.quoteOnlyCountries.includes(country)) {
    return { mode: "quote_only", reason: "QUOTE_ONLY", notices };
  }
  const zoneId = zoneOf(country, settings.zones);
  const zone = settings.zones.find((z) => z.id === zoneId);
  if (!zone?.enabled) {
    return { mode: "quote_only", reason: "ZONE_DISABLED", notices };
  }
  const cap = settings.valueCaps.find((c) => c.carrier === i.carrier);
  if (cap && value > usdToIls(Math.round(cap.maxUsd * 100), fx.ilsPerUsd)) {
    return { mode: "quote_only", reason: "VALUE_CAP", notices };
  }
  return { mode: "ok", notices };
}

/**
 * Address script rule (spec §4.4 "Addresses"): abroad every non-empty field must be Latin script
 * (labels and customs forms); Hebrew is allowed for Israel. Returns the offending field names.
 */
export function nonLatinAddressFields<
  T extends Record<string, string | null | undefined>,
>(country: string, fields: T): (keyof T)[] {
  return nonLatinFields(fields, country);
}
