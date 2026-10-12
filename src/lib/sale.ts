import { jerusalemDateKey } from "@/lib/format";

/**
 * The site-wide sale (`checkout.sale` in the settings): a percentage off every work's price
 * between two Israel-calendar dates, both inclusive. The list prices stay as they are; the sale is
 * applied on top of them wherever a price is shown or charged, so it ends by itself.
 */
export interface SaleConfig {
  enabled: boolean;
  percentOff: number;
  /** ISO date (Israel calendar) of the first day; null = already started. */
  startsOn: string | null;
  /** ISO date (Israel calendar) of the last day; null = no end. */
  endsOn: string | null;
  label: { he: string; en: string };
}

export interface ActiveSale {
  percentOff: number;
  label: { he: string; en: string };
  endsOn: string | null;
}

/** The sale running at `now` (Israel time), or null. */
export function activeSale(
  sale: SaleConfig | null | undefined,
  now: Date = new Date(),
): ActiveSale | null {
  if (!sale?.enabled || sale.percentOff <= 0) return null;
  const today = jerusalemDateKey(now);
  if (sale.startsOn && today < sale.startsOn) return null;
  if (sale.endsOn && today > sale.endsOn) return null;
  return {
    percentOff: sale.percentOff,
    label: sale.label,
    endsOn: sale.endsOn,
  };
}

/** A list price after the sale, in minor units, rounded to whole shekels or dollars. */
export function salePriceMinor(listMinor: number, percentOff: number): number {
  return Math.max(
    100,
    Math.round((listMinor * (100 - percentOff)) / 100 / 100) * 100,
  );
}

/** `listMinor` with the sale applied (null stays null). */
export function applySale(
  listMinor: number | null,
  sale: ActiveSale | null,
): number | null {
  if (listMinor === null || !sale) return listMinor;
  return salePriceMinor(listMinor, sale.percentOff);
}
