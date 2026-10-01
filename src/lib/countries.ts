/**
 * Countries (spec §4.4, §5.1): ISO 3166-1 alpha-2 codes, the shipping zones' default membership,
 * the default deny list, and localized names via `Intl.DisplayNames` sorted with `Intl.Collator`.
 * Pure data and helpers; the painter edits zone membership in `settings.shipping` (this module
 * only provides the defaults the seed writes and the rules engine falls back to).
 */
import type { Locale } from "./locale";

// biome-ignore format: rows of 16 codes keep the list scannable
export const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
  "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
  "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
  "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
  "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
  "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
  "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

const COUNTRY_SET: ReadonlySet<string> = new Set(COUNTRY_CODES);

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === "string" && COUNTRY_SET.has(value);
}

/** Upper-cases and validates user input (`"us"` → `"US"`), or null. */
export function parseCountryCode(value: string): CountryCode | null {
  const code = value.trim().toUpperCase();
  return isCountryCode(code) ? code : null;
}

export const HOME_COUNTRY = "IL" satisfies CountryCode;

// ---------------------------------------------------------------- zones (spec §4.4)

export const ZONE_IDS = [
  "IL",
  "EUROPE",
  "NORTH_AMERICA",
  "REST_OF_WORLD",
] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

/** The 27 EU member states. */
// biome-ignore format: compact list
export const EU27 = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const satisfies readonly CountryCode[];

/** EUROPE zone = EU27 + GB + CH + NO (disabled by default, so it routes to a quote). */
export const EUROPE_ZONE_COUNTRIES = [
  ...EU27,
  "GB",
  "CH",
  "NO",
] as const satisfies readonly CountryCode[];

export const NORTH_AMERICA_ZONE_COUNTRIES = [
  "US",
  "CA",
] as const satisfies readonly CountryCode[];

/** Blocked and hidden from the selector; IQ may be removed by the painter. */
export const DEFAULT_DENIED_COUNTRIES = [
  "IR",
  "SY",
  "LB",
  "IQ",
] as const satisfies readonly CountryCode[];

/** The only entry of the default deny list the painter may remove. */
export const REMOVABLE_DENIED_COUNTRIES = [
  "IQ",
] as const satisfies readonly CountryCode[];

const EU_SET: ReadonlySet<string> = new Set(EU27);

export function isEuCountry(code: string): boolean {
  return EU_SET.has(code);
}

/** Default zone of a country (REST_OF_WORLD catches everything else). */
export function defaultZoneOf(code: string): ZoneId {
  if (code === "IL") return "IL";
  if ((EUROPE_ZONE_COUNTRIES as readonly string[]).includes(code)) {
    return "EUROPE";
  }
  if ((NORTH_AMERICA_ZONE_COUNTRIES as readonly string[]).includes(code)) {
    return "NORTH_AMERICA";
  }
  return "REST_OF_WORLD";
}

/**
 * Zone of a country given configured zones (`settings.shipping.zones`): an explicit listing wins,
 * then a zone whose list contains `"*"`, else REST_OF_WORLD.
 */
export function zoneOf(
  code: string,
  zones: readonly { id: ZoneId; countries: readonly string[] }[],
): ZoneId {
  const explicit = zones.find((z) => z.countries.includes(code));
  if (explicit) return explicit.id;
  const wildcard = zones.find((z) => z.countries.includes("*"));
  return wildcard?.id ?? "REST_OF_WORLD";
}

// ---------------------------------------------------------------- display

const INTL: Record<Locale, string> = { he: "he-IL", en: "en-IL" };
const displayNames = new Map<Locale, Intl.DisplayNames>();

/** Localized country name, e.g. `countryName("DE", "he")` → "גרמניה". Falls back to the code. */
export function countryName(code: string, locale: Locale): string {
  let dn = displayNames.get(locale);
  if (!dn) {
    dn = new Intl.DisplayNames([INTL[locale]], {
      type: "region",
      fallback: "code",
    });
    displayNames.set(locale, dn);
  }
  try {
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Territories without a resident population, never offered as a destination. */
const UNINHABITED: ReadonlySet<string> = new Set([
  "AQ",
  "BV",
  "GS",
  "HM",
  "TF",
  "UM",
]);

export interface CountryOption {
  code: CountryCode;
  name: string;
}

/**
 * Options for the checkout country `<select>`: localized names sorted by `Intl.Collator`, with
 * `exclude` (the deny list) removed. Israel is listed first.
 */
export function countryOptions(
  locale: Locale,
  exclude: readonly string[] = DEFAULT_DENIED_COUNTRIES,
): CountryOption[] {
  const skip = new Set(exclude);
  const collator = new Intl.Collator(INTL[locale]);
  const options = COUNTRY_CODES.filter(
    (c) => !skip.has(c) && c !== HOME_COUNTRY && !UNINHABITED.has(c),
  ).map((code) => ({ code, name: countryName(code, locale) }));
  options.sort((a, b) => collator.compare(a.name, b.name));
  return skip.has(HOME_COUNTRY)
    ? options
    : [
        { code: HOME_COUNTRY, name: countryName(HOME_COUNTRY, locale) },
        ...options,
      ];
}
