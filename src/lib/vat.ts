/**
 * VAT constants and maths (spec §4.7). Prices are consumer totals: for an osek murshe the VAT is
 * *included* in `price_ils_minor`; an osek patur charges none; zero-rated exports carry 0 VAT
 * (accountant to confirm). Rates are in basis points (1800 = 18 %).
 */
import { assertMinor } from "./money";

export type VatMode = "OSEK_PATUR" | "OSEK_MURSHE";

/** Effective-dated Israeli VAT rates, ascending by `from` (Asia/Jerusalem calendar dates). */
export const VAT_RATES = [{ from: "2025-01-01", rateBp: 1800 }] as const;

/** Osek patur annual turnover ceiling in ILS minor units, by calendar year. */
export const PATUR_CEILING: Readonly<Record<number, number>> = {
  2026: 12_283_300,
};

function isoDay(date: Date | string): string {
  if (typeof date === "string") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) throw new RangeError("bad date");
    return date.slice(0, 10);
  }
  // The Israeli calendar day of an instant.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The VAT rate in force on a date. Throws for dates before the first known rate. */
export function vatRateBpOn(date: Date | string): number {
  const day = isoDay(date);
  let rate: number | undefined;
  for (const r of VAT_RATES) if (r.from <= day) rate = r.rateBp;
  if (rate === undefined) throw new RangeError(`no VAT rate known for ${day}`);
  return rate;
}

/** VAT included in a gross amount: `gross × rate / (1 + rate)`, rounded half up. */
export function includedVatMinor(grossMinor: number, rateBp: number): number {
  assertMinor(grossMinor);
  if (!Number.isInteger(rateBp) || rateBp < 0) throw new RangeError("bad rate");
  if (rateBp === 0 || grossMinor === 0) return 0;
  const num = BigInt(grossMinor) * BigInt(rateBp);
  const den = BigInt(10_000 + rateBp);
  const q = num / den;
  const r = num % den;
  return Number(r * 2n >= den ? q + 1n : q);
}

export interface OrderVatInput {
  vatMode: VatMode;
  /** Goods exported abroad: zero-rated (accountant to confirm). */
  zeroRatedExport: boolean;
  totalMinor: number;
  date: Date | string;
}

/** The order's VAT snapshot (`orders.vat_rate_bp`, `orders.vat_minor`). */
export function vatForOrder(i: OrderVatInput): {
  rateBp: number;
  vatMinor: number;
} {
  if (i.vatMode === "OSEK_PATUR" || i.zeroRatedExport) {
    return { rateBp: 0, vatMinor: 0 };
  }
  const rateBp = vatRateBpOn(i.date);
  return { rateBp, vatMinor: includedVatMinor(i.totalMinor, rateBp) };
}

/** Net amount (before VAT) of a gross amount. */
export function netOfVatMinor(grossMinor: number, rateBp: number): number {
  return grossMinor - includedVatMinor(grossMinor, rateBp);
}

/** The patur ceiling for `year`, or null when the year is not configured yet. */
export function paturCeilingMinor(year: number): number | null {
  return PATUR_CEILING[year] ?? null;
}

export type CeilingLevel = "ok" | "warn80" | "warn95" | "over" | "unknown";

/** Turnover against the ceiling (daily alert at ≥ 80 % and ≥ 95 %, spec §5.11). */
export function paturCeilingLevel(
  turnoverMinor: number,
  year: number,
): CeilingLevel {
  const ceiling = paturCeilingMinor(year);
  if (ceiling === null) return "unknown";
  if (turnoverMinor > ceiling) return "over";
  if (turnoverMinor * 100 >= ceiling * 95) return "warn95";
  if (turnoverMinor * 100 >= ceiling * 80) return "warn80";
  return "ok";
}
