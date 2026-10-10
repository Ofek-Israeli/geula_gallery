import "server-only";
import { mmToCmCeil } from "./carriers/dhl-map";
import type { PostSizeLimit } from "./tariff";
import { ISRAEL_POST_2026 as T } from "./tariff";
import type { IsraelPostDetail, IsraelPostPiece } from "./types";

/**
 * Israel Post's published prices for the `ISRAEL_POST` method (`tariff/israel-post-2026.ts`).
 * Pure; ILS minor units. One parcel per work, priced by its actual weight:
 * - in Israel, home delivery (counter to door, next day): the weight band's inter-city price;
 * - abroad, EMS: the destination's group price for the weight rounded up to 0.5 kg (up to 0.5 kg,
 *   up to 1 kg, then each further 0.5 kg).
 * A parcel must fit: 20 kg; no side over the limit; longest side + girth (twice the other two) at
 * most the limit (Israel 150/300 cm; abroad the destination's 105/200 or 150/300). EMS goes only
 * to the countries the price list serves. docs/pricing/shipping-taxes-and-fees.tex explains it.
 */

export interface PostPieceInput {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: number;
}

export type IsraelPostFailure =
  | "NO_PIECES"
  | "NOT_SERVED"
  | "TOO_HEAVY"
  | "TOO_LARGE";

export type IsraelPostResult =
  | { ok: true; detail: IsraelPostDetail }
  | { ok: false; reason: IsraelPostFailure };

const HALF_KG_G = 500;
const KG_G = 1000;

/** The EMS group of a destination, or null when Israel Post sends no EMS there (and IL). */
export function emsGroupOf(country: string): number | null {
  for (const [group, codes] of Object.entries(T.ems.countryGroups)) {
    if (codes.includes(country)) return Number(group);
  }
  return null;
}

/** The size limit for a destination: Israel's, or the EMS destination's (stricter if unlisted). */
export function israelPostLimitOf(country: string): PostSizeLimit {
  if (country === "IL") return T.domestic.limit;
  return (
    T.ems.limits.find((l) => l.countries.includes(country)) ?? {
      maxSideCm: 105,
      maxLengthGirthCm: 200,
    }
  );
}

function emsPriceMinor(group: number, billedG: number): number {
  const g = T.ems.groups[group];
  if (!g) throw new RangeError(`no EMS group ${group}`);
  if (billedG <= HALF_KG_G) return g.upTo500;
  if (billedG <= KG_G) return g.upTo1000;
  return g.upTo1000 + ((billedG - KG_G) / HALF_KG_G) * g.perExtra500;
}

export function israelPostEstimate(i: {
  pieces: readonly PostPieceInput[];
  country: string;
}): IsraelPostResult {
  if (i.pieces.length === 0) return { ok: false, reason: "NO_PIECES" };
  const domestic = i.country === "IL";
  const group = domestic ? null : emsGroupOf(i.country);
  if (!domestic && group === null) return { ok: false, reason: "NOT_SERVED" };
  const limit = israelPostLimitOf(i.country);
  const maxWeightG = domestic ? T.domestic.maxWeightG : T.ems.maxWeightG;

  const pieces: IsraelPostPiece[] = [];
  for (const p of i.pieces) {
    const dimsCm = [
      mmToCmCeil(p.lengthMm),
      mmToCmCeil(p.widthMm),
      mmToCmCeil(p.heightMm),
    ].sort((a, b) => b - a) as [number, number, number];
    const [longest, second, third] = dimsCm;
    if (p.weightG > maxWeightG) return { ok: false, reason: "TOO_HEAVY" };
    if (
      longest > limit.maxSideCm ||
      longest + 2 * (second + third) > limit.maxLengthGirthCm
    ) {
      return { ok: false, reason: "TOO_LARGE" };
    }
    if (domestic) {
      const band = T.domestic.bands.find((b) => p.weightG <= b.upToG);
      if (!band) return { ok: false, reason: "TOO_HEAVY" };
      pieces.push({
        dimsCm,
        actualG: p.weightG,
        billedG: p.weightG,
        priceMinor: band.minor,
      });
    } else {
      const billedG = Math.ceil(p.weightG / HALF_KG_G) * HALF_KG_G;
      pieces.push({
        dimsCm,
        actualG: p.weightG,
        billedG,
        priceMinor: emsPriceMinor(group as number, billedG),
      });
    }
  }
  return {
    ok: true,
    detail: {
      tariff: T.id,
      service: domestic ? "DOMESTIC_DOOR" : "EMS",
      group,
      pieces,
      totalMinor: pieces.reduce((s, p) => s + p.priceMinor, 0),
    },
  };
}

/**
 * EMS liability extension ("ביטוח"): ₪6.90 per ₪1,000 of value or part of it, on at most
 * ₪25,000. Returns the covered value and the premium (ILS minor units).
 */
export function emsInsurance(valueMinor: number): {
  valueMinor: number;
  premiumMinor: number;
} {
  const covered = Math.max(
    0,
    Math.min(valueMinor, T.ems.insurance.maxValueMinor),
  );
  return {
    valueMinor: covered,
    premiumMinor:
      Math.ceil(covered / 100_000) * T.ems.insurance.perThousandMinor,
  };
}
