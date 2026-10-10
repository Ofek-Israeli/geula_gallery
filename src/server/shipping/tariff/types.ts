import "server-only";
import type { DhlDemandRegion, DhlZone } from "../types";

/** One value per DHL zone, zone 1 first (ILS minor units). */
export type PerZone = readonly [number, number, number, number, number, number];

/**
 * A published DHL Express export tariff (one rate guide), as pure data in ILS minor units.
 * See `dhl-express-il-2026.ts` for the sources and what each field means.
 */
export interface DhlTariff {
  id: string;
  name: string;
  /** First day the guide applies (ISO date, Asia/Jerusalem). */
  validFrom: string;
  /** When to look for the next guide (the settings page flags it from this day). */
  reviewBy: string;
  /** When the data was last checked against DHL's pages. */
  checkedOn: string;
  sources: {
    rateGuide: string;
    surcharges: string;
    demandSurcharge: string;
    notices: string;
    customsServices: string;
  };
  divisorCm3PerKg: number;
  /** Published weights in half-kilos with their price per zone. */
  rows: readonly (readonly [number, PerZone])[];
  perHalfKgAbove10: PerZone;
  perHalfKgAbove20: PerZone;
  perKg30To70: PerZone;
  perKg70To300: PerZone;
  perKg300To3000: PerZone;
  zones: Readonly<Record<DhlZone, readonly string[]>>;
  /** Selector codes the guide does not list. */
  noZone: readonly string[];
  limits: {
    pieceLengthCm: number;
    pieceWeightKg: number;
    shipmentWeightKg: number;
  };
  piece: {
    overweightMinor: number;
    /** A piece over this actual or volumetric weight is Overweight. */
    overweightKg: number;
    oversizeMinor: number;
    oversizeLongestCm: number;
    oversizeSecondCm: number;
    nonConveyableMinor: number;
    nonConveyableMinKg: number;
    nonConveyableMaxKg: number;
  };
  /** Per shipment, outside the fuel base. */
  restrictedDestination: { minor: number; countries: readonly string[] };
  /** Per shipment, inside the fuel base. Israel's own listing is suspended since the given day. */
  elevatedRisk: {
    minor: number;
    countries: readonly string[];
    israelSuspendedSince: string | null;
  };
  /** Documented only: DHL's remote-area list is a per-address lookup, so it is not estimated. */
  remoteArea: { perKgMinor: number; minMinor: number };
  /** Demand surcharge windows (inclusive Jerusalem days), per kg of billing weight. */
  demand: readonly {
    from: string;
    to: string;
    minorPerKg: Readonly<Record<DhlDemandRegion, number>>;
  }[];
  demandRegions: Readonly<
    Record<Exclude<DhlDemandRegion, "ROW">, readonly string[]>
  >;
  /** The published range of the weekly fuel surcharge (sanity bounds for the settings). */
  fuel: { minPct: number; maxPct: number };
  /** Customs service, per shipment; Israeli VAT is added (`plusVat`); outside the fuel base. */
  exportDeclaration: { minor: number; plusVat: boolean };
  /** Shipment Insurance as DHL publishes it: max(ratePct × value, minMinor). */
  insurance: { ratePct: number; minMinor: number };
}

/** An Israel Post price band: up to `upToG` grams costs `minor` (ILS minor units, VAT included). */
export interface PostWeightBand {
  upToG: number;
  minor: number;
}

/** Israel Post's size rule: no side over `maxSideCm`, longest + girth (2 × the other two). */
export interface PostSizeLimit {
  maxSideCm: number;
  maxLengthGirthCm: number;
}

/**
 * Israel Post's published 2026 prices and limits (see `israel-post-2026.ts`), ILS minor units.
 * Domestic: one service and its bands. Abroad: EMS by destination group (1–13) and weight.
 */
export interface IsraelPostTariff {
  id: string;
  name: string;
  checkedOn: string;
  sources: { domestic: string; ems: string; postalGuide: string };
  domestic: {
    validFrom: string;
    /** Counter to door, next day; the inter-city column (the in-city one is cheaper). */
    bands: readonly PostWeightBand[];
    inCityBands: readonly PostWeightBand[];
    maxWeightG: number;
    limit: PostSizeLimit;
  };
  ems: {
    validFrom: string;
    /** Counter price per item: up to 0.5 kg, over 0.5 up to 1 kg, each further 0.5 kg or part. */
    groups: Readonly<
      Record<number, { upTo500: number; upTo1000: number; perExtra500: number }>
    >;
    countryGroups: Readonly<Record<number, readonly string[]>>;
    maxWeightG: number;
    /** Per-destination size limits (the post's parcel table; unclear entries take 105/200). */
    limits: readonly (PostSizeLimit & { countries: readonly string[] })[];
    /** Liability extension: `perThousandMinor` per ₪1,000 (or part) of value, up to the cap. */
    insurance: { perThousandMinor: number; maxValueMinor: number };
  };
}
