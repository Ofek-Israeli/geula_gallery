/**
 * Israeli identity numbers (teudat zehut) and passports (spec §5.7 cancellation form). The ID has
 * 9 digits with a Luhn-style check digit; shorter inputs are left-padded with zeros. A passport is
 * accepted as 5–20 Latin letters and digits (no checksum exists across countries).
 */

/** Strips spaces and dashes; returns the 9-digit form, or null when it cannot be an ID. */
export function normalizeIsraeliId(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{5,9}$/.test(digits)) return null;
  return digits.padStart(9, "0");
}

/** The check-digit test: weights 1,2,1,2…, products above 9 have their digits summed. */
export function hasValidIsraeliIdChecksum(nineDigits: string): boolean {
  if (!/^\d{9}$/.test(nineDigits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(nineDigits[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

/** True for a well-formed Israeli ID with a valid check digit (all zeros is rejected). */
export function isValidIsraeliId(input: string): boolean {
  const id = normalizeIsraeliId(input);
  return id !== null && id !== "000000000" && hasValidIsraeliIdChecksum(id);
}

/** Computes the check digit for the first 8 digits (used by test factories). */
export function israeliIdCheckDigit(eightDigits: string): number {
  if (!/^\d{8}$/.test(eightDigits)) throw new RangeError("need 8 digits");
  for (let d = 0; d <= 9; d++) {
    if (hasValidIsraeliIdChecksum(`${eightDigits}${d}`)) return d;
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

const PASSPORT_RE = /^[A-Z0-9]{5,20}$/;

export function normalizePassport(input: string): string | null {
  const p = input.replace(/[\s-]/g, "").toUpperCase();
  return PASSPORT_RE.test(p) ? p : null;
}

export type IdentityDocument =
  | { kind: "IL_ID"; value: string }
  | { kind: "PASSPORT"; value: string };

/**
 * What the cancellation form's "ID / passport number" field holds: a valid Israeli ID when the input
 * is all digits and passes the checksum, else a passport-shaped value, else null.
 */
export function parseIdOrPassport(input: string): IdentityDocument | null {
  const compact = input.replace(/[\s-]/g, "");
  if (/^\d+$/.test(compact)) {
    const id = normalizeIsraeliId(compact);
    if (id && isValidIsraeliId(id)) return { kind: "IL_ID", value: id };
    // An all-digit foreign passport (e.g. 9-digit US) is still accepted as a passport.
    return compact.length >= 6 && compact.length <= 20
      ? { kind: "PASSPORT", value: compact }
      : null;
  }
  const passport = normalizePassport(compact);
  return passport ? { kind: "PASSPORT", value: passport } : null;
}

/** Display mask keeping the last 2 characters (`•••••••12`), as in `ack_snapshot` (spec §7). */
export function maskIdentity(value: string): string {
  const v = value.replace(/[\s-]/g, "");
  if (v.length <= 2) return "•".repeat(v.length);
  return `${"•".repeat(v.length - 2)}${v.slice(-2)}`;
}

/** The last 3 characters (`cancellations.id_number_last3`, for admin matching). */
export function identityLast3(value: string): string {
  return value.replace(/[\s-]/g, "").slice(-3);
}
