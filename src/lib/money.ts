/**
 * Money (spec §2.5, §6.4): integer minor units plus an ISO currency. Display uses server Intl
 * (`he-IL` / `en-IL`); whole amounts are shown without decimals. Arithmetic never uses floats for
 * money: decimals are parsed as strings and conversions use integer (BigInt) maths.
 */
export const CURRENCIES = ["ILS", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export type MoneyLocale = "he" | "en";

export interface Money {
  amountMinor: number;
  currency: Currency;
}

const INTL_LOCALE: Record<MoneyLocale, string> = { he: "he-IL", en: "en-IL" };

export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (CURRENCIES as readonly string[]).includes(value)
  );
}

export class MoneyError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Throws unless `n` is a safe integer (minor units). */
export function assertMinor(n: number, what = "amountMinor"): number {
  if (!Number.isSafeInteger(n))
    throw new MoneyError(`${what} must be a safe integer`);
  return n;
}

export function money(amountMinor: number, currency: Currency): Money {
  return { amountMinor: assertMinor(amountMinor), currency };
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

export function formatMoneyValue(m: Money, locale: MoneyLocale): string {
  return formatMoney(m.amountMinor, m.currency, locale);
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a decimal amount into minor units: `"1200"` → 120000, `"45.5"` → 4550, `12.34` → 1234.
 * Rejects more than 2 decimal places, exponents, separators and non-finite numbers.
 */
export function fromDecimal(value: string | number): number {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyError("amount must be finite");
    text = String(value);
  } else {
    text = value.trim();
  }
  const m = DECIMAL_RE.exec(text);
  if (!m) {
    throw new MoneyError(
      `invalid amount (at most 2 decimal places, no separators): ${JSON.stringify(text)}`,
    );
  }
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return assertMinor(sign * (whole * 100 + frac));
}

/** Minor units → a 2-decimal string (`120000` → `"1200.00"`), as PayPal and Cardcom expect. */
export function toDecimalString(amountMinor: number): string {
  assertMinor(amountMinor);
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Minor units → major units as a number (`4550` → 45.5). For providers that take numbers. */
export function toMajor(amountMinor: number): number {
  return Number(toDecimalString(amountMinor));
}

/** Whole major units → minor units (`1200` → 120000). Settings store whole ILS/USD values. */
export function wholeToMinor(whole: number): number {
  return fromDecimal(whole);
}

export function sumMinor(values: readonly number[]): number {
  return assertMinor(
    values.reduce((a, b) => a + assertMinor(b), 0),
    "sum",
  );
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new MoneyError("currency mismatch");
  return money(a.amountMinor + b.amountMinor, a.currency);
}

/** `value × bp / 10000`, rounded half away from zero (basis points: 500 = 5 %). */
export function applyBasisPoints(valueMinor: number, bp: number): number {
  assertMinor(valueMinor);
  if (!Number.isInteger(bp)) throw new MoneyError("bp must be an integer");
  const n = BigInt(valueMinor) * BigInt(bp);
  const q = n / 10000n;
  const r = n % 10000n;
  const abs = r < 0n ? -r : r;
  const rounded = abs * 2n >= 10000n ? q + (n < 0n ? -1n : 1n) : q;
  return Number(rounded);
}

/** A positive decimal rate (e.g. FX 3.7) as an exact integer number of micro-units. */
function rateMicro(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0)
    throw new MoneyError("rate must be > 0");
  return BigInt(Math.round(rate * 1_000_000));
}

/**
 * ILS minor → USD minor, rounded **up to whole dollars** (spec §4.4: USD orders convert shipping
 * and insurance once with the dated `fx.ilsPerUsd` and lock the result).
 */
export function ilsToUsdCeilWhole(ilsMinor: number, ilsPerUsd: number): number {
  assertMinor(ilsMinor);
  if (ilsMinor <= 0) return 0;
  // usdDollars = ilsMinor / 100 / rate = ilsMinor * 1e6 / (rateMicro * 100)
  const num = BigInt(ilsMinor) * 1_000_000n;
  const den = rateMicro(ilsPerUsd) * 100n;
  const dollars = (num + den - 1n) / den;
  return Number(dollars * 100n);
}

/** USD minor → ILS minor at the locked reference rate, rounded half up (fees, reporting). */
export function usdToIls(usdMinor: number, ilsPerUsd: number): number {
  assertMinor(usdMinor);
  const num = BigInt(usdMinor) * rateMicro(ilsPerUsd);
  const q = num / 1_000_000n;
  const r = num % 1_000_000n;
  return Number(r * 2n >= 1_000_000n ? q + 1n : q);
}

/** Generic `amount (in `from`) → ILS minor` with a reference rate (EUR, GBP thresholds). */
export function toIlsMinor(amountMinor: number, ilsPerUnit: number): number {
  return usdToIls(amountMinor, ilsPerUnit);
}
