import "server-only";

/**
 * Redaction and masking (spec §7 PII). Used by the logger, audit rows and stored provider payloads.
 * Masked forms are what appears in `ack_snapshot`, screens and emails; full ID numbers exist only
 * encrypted (AES-256-GCM).
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?(key|name|password)|signature|card(number)?|cvv|cvc|pan|iban|id[-_]?number|identity|passport|totp|backup[-_]?codes?|otp/i;

/** Keys that are safe even though they match the pattern above. */
const ALLOWED_KEYS = new Set([
  "cardLast4",
  "card_last4",
  "cardBrand",
  "card_brand",
  "Last4CardDigitsString",
  "tokenType",
]);

export function isSensitiveKey(key: string): boolean {
  return !ALLOWED_KEYS.has(key) && SENSITIVE_KEY.test(key);
}

/** Deep copy with sensitive keys replaced by `[REDACTED]`. Cycles and depth > 8 are cut. */
export function redact<T>(
  value: T,
  depth = 0,
  seen = new WeakSet<object>(),
): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (depth > 8 || seen.has(value as object)) return REDACTED as T;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out as T;
}

/** `painter@example.com` → `p*****r@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked =
    local.length <= 2
      ? `${local[0] ?? ""}*`
      : `${local[0]}${"*".repeat(Math.min(local.length - 2, 5))}${local.at(-1)}`;
  return `${masked}@${domain}`;
}

/** Israeli ID / passport number: only the last 2 characters are shown (`*******18`). */
export function maskIdNumber(id: string): string {
  const clean = id.replace(/\s+/g, "");
  if (clean.length <= 2) return "*".repeat(clean.length);
  return `${"*".repeat(clean.length - 2)}${clean.slice(-2)}`;
}

/** Phone: only the last 3 digits are shown. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 3) return "***";
  return `${"*".repeat(digits.length - 3)}${digits.slice(-3)}`;
}
