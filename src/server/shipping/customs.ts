import "server-only";
import { notImplemented } from "@/server/domain/errors";

/**
 * Customs data (spec §4.4 "Customs"): HS 9701.91 with per-destination extensions, the English
 * description generator, the EU Reg 2019/880 "not concerned" statement, and the export
 * declaration threshold (REQUIRED above USD 200). Constants are final; generator bodies: WS3.
 */
export const HS_CODE = "9701.91";
export const EXPORT_COMMODITY_CODE = "9701910000";
export const IMPORT_COMMODITY_CODES: Readonly<Record<string, string>> = {
  US: "9701.91.0000",
  EU: "97019100",
  IL: "9701910000",
};

export function customsDescriptionEn(_input: {
  mediumText: string;
  yearCreated?: number | null;
  artistName: string;
}): string {
  return notImplemented("customsDescriptionEn", "WS3");
}

export function exportDeclarationRequired(
  _declaredValueUsdMinor: number,
  _thresholdUsd: number,
): boolean {
  return notImplemented("exportDeclarationRequired", "WS3");
}
