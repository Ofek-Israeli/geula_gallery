/**
 * The checkout destination (step 1 of the checkout, spec §5.1): country, city and postal code,
 * which is enough to quote (the price depends on the country only). Pure, so the step 1 page, the
 * details form's action and the tests apply one set of rules:
 * - the country is a known code and, when `offered` is given, one the selector offers;
 * - a city is required (at most 120 characters);
 * - a postal code is required abroad unless the destination has none, and optional in Israel
 *   (at most 20 characters);
 * - abroad, the city and the postal code are in Latin script (carriers print them on labels).
 */
import { isCountryCode, postalCodeRequired } from "../countries";
import { nonLatinFields } from "../script";

/** Must equal the details form's limits (`checkoutFields` in the checkout's `start-input.ts`). */
export const DESTINATION_LIMITS = { city: 120, postalCode: 20 } as const;

export type DestinationField = "country" | "city" | "postalCode";
export type DestinationIssue =
  | "required"
  | "latin_only"
  | "too_long"
  | "invalid_country";
/** At most one issue per field: required, then too long, then Latin script. */
export type DestinationIssues = Partial<
  Record<DestinationField, DestinationIssue>
>;

export interface Destination {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  city?: string | null;
  postalCode?: string | null;
}

export function destinationIssues(
  d: Destination,
  offered?: ReadonlySet<string>,
): DestinationIssues {
  const issues: DestinationIssues = {};
  if (
    !isCountryCode(d.country) ||
    (offered !== undefined && !offered.has(d.country))
  ) {
    issues.country = "invalid_country";
  }
  const city = d.city?.trim() ?? "";
  const postalCode = d.postalCode?.trim() ?? "";
  if (city === "") issues.city = "required";
  else if (city.length > DESTINATION_LIMITS.city) issues.city = "too_long";
  if (postalCode === "") {
    if (postalCodeRequired(d.country)) issues.postalCode = "required";
  } else if (postalCode.length > DESTINATION_LIMITS.postalCode) {
    issues.postalCode = "too_long";
  }
  for (const field of nonLatinFields({ city, postalCode }, d.country)) {
    issues[field] ??= "latin_only";
  }
  return issues;
}
