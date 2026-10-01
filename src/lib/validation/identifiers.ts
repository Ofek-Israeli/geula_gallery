/**
 * Pure parsing of human-facing identifiers (spec §2.5): order numbers `GG-` + 6 Crockford base32
 * characters, cancellation numbers `C-` + 6, slugs. Generators live in `src/server/domain/ids.ts`
 * (server-only, crypto randomness), which re-exports these.
 */

/** Crockford base32 omits I, L, O and U, so numbers read aloud on the phone are unambiguous. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ORDER_NUMBER_RE = /^GG-[0-9A-HJKMNP-TV-Z]{6}$/;
export const CANCELLATION_NUMBER_RE = /^C-[0-9A-HJKMNP-TV-Z]{6}$/;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Upper-cases, strips spaces/dashes, maps I/L→1 and O→0. */
export function normalizeCrockford(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function isOrderNumber(value: string): boolean {
  return ORDER_NUMBER_RE.test(value);
}

export function isCancellationNumber(value: string): boolean {
  return CANCELLATION_NUMBER_RE.test(value);
}

/**
 * Parses what a buyer typed as an order number (`gg-7k3m9q`, `7K3M 9Q`, `GG7K3M9Q`) into the
 * canonical form, or null.
 */
export function parseOrderNumber(input: string): string | null {
  const n = normalizeCrockford(input.trim());
  const body = n.startsWith("GG") && n.length === 8 ? n.slice(2) : n;
  const candidate = `GG-${body}`;
  return ORDER_NUMBER_RE.test(candidate) ? candidate : null;
}

/** Like `parseOrderNumber` for cancellation numbers (`c-abc123` → `C-ABC123`). */
export function parseCancellationNumber(input: string): string | null {
  const n = normalizeCrockford(input.trim());
  const body = n.startsWith("C") && n.length === 7 ? n.slice(1) : n;
  const candidate = `C-${body}`;
  return CANCELLATION_NUMBER_RE.test(candidate) ? candidate : null;
}

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** Best-effort slug from a Latin title (`"Sunset, Jaffa"` → `"sunset-jaffa"`); "" if nothing usable. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
