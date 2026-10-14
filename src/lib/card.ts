/**
 * Card details as our own payment page checks them in the browser (`/checkout/pay/card`). Nothing
 * here sends or keeps them.
 *
 * - International cards: 13–19 digits with the Luhn (mod 10) check digit; the brand comes from
 *   the number's prefix.
 * - Isracard's local cards: 8 or 9 digits with a mod-11 check (weights 9…1 from the left once
 *   padded to 9 digits). This rule is community-documented; no official Isracard source was
 *   found (checked 2026-10-14).
 */

export const CARD_BRANDS = [
  "isracard",
  "visa",
  "mastercard",
  "amex",
  "diners",
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

/** Digits only (spaces and dashes are allowed while typing). */
export function cardDigits(input: string): string {
  return input.replace(/[\s-]/g, "");
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Isracard's local 8–9 digit cards. */
export function isracardValid(digits: string): boolean {
  if (!/^\d{8,9}$/.test(digits)) return false;
  const nine = digits.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(nine[i]) * (9 - i);
  return sum % 11 === 0;
}

function prefixBrand(digits: string): CardBrand | null {
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(digits)) {
    return "mastercard";
  }
  if (/^3[47]/.test(digits)) return "amex";
  if (/^3(0[0-5]|[689])/.test(digits)) return "diners";
  return null;
}

/**
 * A card number's check: `valid`, and the brand when it is one we name (a valid number of another
 * brand has `brand: null`).
 */
export function checkCardNumber(input: string): {
  valid: boolean;
  brand: CardBrand | null;
} {
  const digits = cardDigits(input);
  if (/^\d{8,9}$/.test(digits)) {
    const valid = isracardValid(digits);
    return { valid, brand: valid ? "isracard" : null };
  }
  if (!/^\d{13,19}$/.test(digits) || !luhnValid(digits)) {
    return { valid: false, brand: null };
  }
  return { valid: true, brand: prefixBrand(digits) };
}

/** Groups of four (American Express 4-6-5; Isracard's short numbers are not grouped). */
export function formatCardNumber(input: string): string {
  const d = cardDigits(input);
  if (!/^\d+$/.test(d) || d.length <= 9) return d;
  if (/^3[47]/.test(d)) {
    return [d.slice(0, 4), d.slice(4, 10), d.slice(10)]
      .filter(Boolean)
      .join(" ");
  }
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** "MM/YY", "MMYY" or "MM / YY" → the month and the full year, or null. */
export function parseExpiry(
  input: string,
): { month: number; year: number } | null {
  const m = /^\s*(\d{1,2})\s*\/?\s*(\d{2})\s*$/.exec(input);
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(m[2]) };
}

/** A card is valid through the last day of its expiry month; at most 20 years ahead. */
export function checkExpiry(
  input: string,
  now: Date,
): "ok" | "invalid" | "expired" {
  const e = parseExpiry(input);
  if (!e) return "invalid";
  const months = e.year * 12 + e.month;
  const current = now.getFullYear() * 12 + (now.getMonth() + 1);
  if (months < current) return "expired";
  if (months > current + 20 * 12) return "invalid";
  return "ok";
}

/** "MM/YY" for display, or the input as typed when it cannot be read. */
export function formatExpiry(input: string): string {
  const e = parseExpiry(input);
  if (!e) return input.trim();
  return `${String(e.month).padStart(2, "0")}/${String(e.year % 100).padStart(2, "0")}`;
}

/** 3 digits; 4 for American Express. */
export function checkCvc(input: string, brand: CardBrand | null): boolean {
  return brand === "amex"
    ? /^\d{4}$/.test(input.trim())
    : /^\d{3}$/.test(input.trim());
}
