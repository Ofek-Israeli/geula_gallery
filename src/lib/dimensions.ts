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
