/**
 * Physical dimensions (spec §2.5): stored as integer millimetres; displayed in cm (1 decimal) and
 * inches (nearest 1/8 in). Always rendered inside `<bdi dir="ltr">` and never mirrored (§6.4).
 */
export type DimensionsLocale = "he" | "en";

const INTL_LOCALE: Record<DimensionsLocale, string> = {
  he: "he-IL",
  en: "en-IL",
};

const EIGHTHS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"] as const;

/** `mmToCm(605)` → 60.5 (rounded to 1 decimal). */
export function mmToCm(mm: number): number {
  return Math.round(mm) / 10;
}

/** Nearest eighth of an inch, as a count of eighths: `mmToEighths(25.4)` → 8. */
export function mmToEighths(mm: number): number {
  return Math.round((mm / 25.4) * 8);
}

export function formatCm(mm: number, locale: DimensionsLocale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    maximumFractionDigits: 1,
  }).format(mmToCm(mm));
}

/** `formatInches(600)` → `23⅝` (nearest 1/8 in). */
export function formatInches(mm: number): string {
  const eighths = mmToEighths(mm);
  const whole = Math.floor(eighths / 8);
  const frac = EIGHTHS[eighths % 8] ?? "";
  if (whole === 0 && frac) return frac;
  return `${whole}${frac}`;
}

export interface DimensionsMm {
  heightMm: number;
  widthMm: number;
  depthMm?: number | null;
}

/** `H × W [× D]` in cm and in inches (spec §6.3 ArtworkFacts). Units are appended by the caller. */
export function formatDimensions(
  d: DimensionsMm,
  locale: DimensionsLocale,
): { cm: string; inches: string } {
  const parts = [d.heightMm, d.widthMm, ...(d.depthMm ? [d.depthMm] : [])];
  return {
    cm: parts.map((mm) => formatCm(mm, locale)).join(" × "),
    inches: parts.map((mm) => formatInches(mm)).join(" × "),
  };
}

// ---------------------------------------------------------------- derived classification

export type Orientation = "PORTRAIT" | "LANDSCAPE" | "SQUARE" | "PANORAMIC";
export type SizeBucket = "S" | "M" | "L" | "XL";

/** Aspect ratios within 5 % count as square; 2:1 or wider counts as panoramic. */
export const SQUARE_TOLERANCE = 1.05;
export const PANORAMIC_RATIO = 2;

/** `artworks.orientation` (derived by the app, spec §3.3). */
export function orientationOf(heightMm: number, widthMm: number): Orientation {
  if (heightMm <= 0 || widthMm <= 0)
    throw new RangeError("dimensions must be > 0");
  const ratio = Math.max(heightMm, widthMm) / Math.min(heightMm, widthMm);
  if (ratio <= SQUARE_TOLERANCE) return "SQUARE";
  if (widthMm > heightMm && ratio >= PANORAMIC_RATIO) return "PANORAMIC";
  return widthMm > heightMm ? "LANDSCAPE" : "PORTRAIT";
}

/** Longest-side thresholds (mm) for the catalog size filter: S < 40 cm ≤ M < 80 cm ≤ L < 120 cm ≤ XL. */
export const SIZE_BUCKET_LIMITS_MM = { S: 400, M: 800, L: 1200 } as const;

/** `artworks.size_bucket` (derived by the app; the catalog size filter). */
export function sizeBucketOf(heightMm: number, widthMm: number): SizeBucket {
  const longest = Math.max(heightMm, widthMm);
  if (longest < SIZE_BUCKET_LIMITS_MM.S) return "S";
  if (longest < SIZE_BUCKET_LIMITS_MM.M) return "M";
  if (longest < SIZE_BUCKET_LIMITS_MM.L) return "L";
  return "XL";
}

/** Sorts box dimensions longest first (L ≥ W ≥ H), as the size classes require (spec §4.4). */
export function sortedDims(
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const s = [a, b, c].sort((x, y) => y - x);
  return [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0];
}

/**
 * Volumetric weight in grams: `L×W×H (cm) / divisor` kg (spec §4.4, default divisor 5000),
 * rounded up to the gram.
 */
export function volumetricWeightG(
  lengthMm: number,
  widthMm: number,
  heightMm: number,
  divisor = 5000,
): number {
  if (divisor <= 0) throw new RangeError("divisor must be > 0");
  const cm3 = (lengthMm * widthMm * heightMm) / 1000;
  return Math.ceil((cm3 / divisor) * 1000);
}

/** Chargeable weight = max(actual, volumetric) (spec §4.4). */
export function chargeableWeightG(
  actualG: number,
  dims: { lengthMm: number; widthMm: number; heightMm: number },
  divisor = 5000,
): number {
  return Math.max(
    actualG,
    volumetricWeightG(dims.lengthMm, dims.widthMm, dims.heightMm, divisor),
  );
}

export function cmToMm(cm: number): number {
  return Math.round(cm * 10);
}

export function inchesToMm(inches: number): number {
  return Math.round(inches * 25.4);
}
