import "server-only";
import { isEuCountry } from "@/lib/countries";
import type { Currency } from "@/lib/money";

/**
 * Customs data (spec §4.4 "Customs"): HS 9701.91 with per-destination extensions, the English
 * description generator, the EU Reg 2019/880 "not concerned" statement, and the export
 * declaration threshold (REQUIRED above USD 200). Pure.
 */
export const HS_CODE = "9701.91";
export const EXPORT_COMMODITY_CODE = "9701910000";
export const IMPORT_COMMODITY_CODES: Readonly<Record<string, string>> = {
  US: "9701.91.0000",
  EU: "97019100",
  IL: "9701910000",
};

/** The inbound (destination) tariff code: US and EU extensions, else the 6-digit HS code. */
export function importCommodityCode(country: string): string {
  if (country === "US") return "9701.91.0000";
  if (isEuCountry(country)) return "97019100";
  if (country === "IL") return "9701910000";
  return HS_CODE;
}

/**
 * EU Regulation 2019/880 (import of cultural goods) concerns works more than 200 years old; an
 * original painting by a living artist is "not concerned". Printed on the commercial invoice for
 * EU destinations. Final wording: lawyer review.
 */
export const EU_CULTURAL_GOODS_STATEMENT =
  "Original painting created less than 200 years ago by the artist named above: not concerned by Regulation (EU) 2019/880 on the introduction and the import of cultural goods.";

/** Origin statement printed on the commercial invoice. */
export const ORIGIN_STATEMENT =
  "The exporter of the products covered by this document declares that the goods are of Israeli origin.";

/** DHL limits `content.description` to 70 characters. */
export const CONTENTS_DESCRIPTION_MAX = 70;

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * English customs description, e.g. "Original painting, oil on canvas, by Geula Example (2024).
 * Hand-painted unique work of art, not a reproduction." `mediumText` is the English medium and
 * surface ("Oil on canvas").
 */
export function customsDescriptionEn(input: {
  mediumText: string;
  yearCreated?: number | null;
  artistName: string;
}): string {
  const medium = input.mediumText.trim().replace(/\.$/, "");
  let head = "Original painting";
  if (medium) head += `, ${lowerFirst(medium)}`;
  const by = input.artistName.trim();
  if (by) head += `, by ${by}`;
  if (input.yearCreated) head += ` (${input.yearCreated})`;
  return `${head}. Hand-painted unique work of art, not a reproduction.`;
}

/** Short contents line for the waybill (at most 70 characters). */
export function contentsDescriptionShort(mediumText: string): string {
  const medium = mediumText.trim().replace(/\.$/, "");
  const full = medium
    ? `Original painting (${lowerFirst(medium)})`
    : "Original painting";
  return full.length <= CONTENTS_DESCRIPTION_MAX ? full : "Original painting";
}

/** True when the declared value is strictly above the threshold (spec: "above USD 200"). */
export function exportDeclarationRequired(
  declaredValueUsdMinor: number,
  thresholdUsd: number,
): boolean {
  return declaredValueUsdMinor > Math.round(thresholdUsd * 100);
}

/**
 * The declared value in USD minor units: USD as is, ILS converted with the dated reference rate
 * and rounded half up to the cent (threshold comparisons only; never charged).
 */
export function declaredValueUsdMinor(
  valueMinor: number,
  currency: Currency,
  ilsPerUsd: number,
): number {
  if (currency === "USD") return valueMinor;
  const rateMicro = BigInt(Math.round(ilsPerUsd * 1_000_000));
  const twice = (BigInt(valueMinor) * 2_000_000n) / rateMicro;
  return Number((twice + 1n) / 2n);
}
