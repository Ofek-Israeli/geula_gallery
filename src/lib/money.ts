/**
 * Money (spec §2.5, §6.4): integer minor units plus an ISO currency. Display uses server Intl
 * (`he-IL` / `en-IL`); whole amounts are shown without decimals.
 *
 * M1 step 7 adds the display helpers the UI primitives need; step 12 may extend this module
 * (arithmetic helpers, VAT) but must keep these signatures.
 */
export const CURRENCIES = ["ILS", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export type MoneyLocale = "he" | "en";

const INTL_LOCALE: Record<MoneyLocale, string> = { he: "he-IL", en: "en-IL" };

export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (CURRENCIES as readonly string[]).includes(value)
  );
}

/** Formats integer minor units, e.g. `formatMoney(120000, "ILS", "en")` → `₪1,200`. */
export function formatMoney(
  amountMinor: number,
  currency: Currency,
  locale: MoneyLocale,
): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("amountMinor must be a safe integer");
  }
  const whole = amountMinor % 100 === 0;
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amountMinor / 100);
}
