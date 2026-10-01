/**
 * Phone numbers (spec §4.4: recipient phone required; §6.4: phones are rendered `dir="ltr"` inside
 * `<bdi>` and never mirrored). Stored in E.164 (`+972501234567`). Israeli local numbers
 * (`050-123-4567`, `03-000-0000`) are converted; other countries must be entered with `+` or `00`.
 * No metadata library: validation is structural (E.164 length) plus Israeli number plans.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Israeli national significant numbers (without the leading 0). */
const IL_NSN_RE = /^(?:5\d{8}|[2-489]\d{7}|7\d{8})$/;

export function isE164(value: string): boolean {
  return E164_RE.test(value);
}

function compact(input: string): string {
  return input.replace(/[\s\-().‎‏]/g, "");
}

/**
 * Parses user input into E.164, or null.
 * - `+…` / `00…`: international;
 * - `0…` with `defaultCountry` IL: Israeli national format.
 */
export function normalizePhone(
  input: string,
  defaultCountry: string = "IL",
): string | null {
  let s = compact(input);
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) {
    if (!E164_RE.test(s)) return null;
    if (s.startsWith("+972")) {
      const nsn = s.slice(4).replace(/^0/, "");
      return IL_NSN_RE.test(nsn) ? `+972${nsn}` : null;
    }
    return s;
  }
  if (defaultCountry === "IL" && /^0\d+$/.test(s)) {
    const nsn = s.slice(1);
    return IL_NSN_RE.test(nsn) ? `+972${nsn}` : null;
  }
  return null;
}

export function isValidPhone(input: string, defaultCountry = "IL"): boolean {
  return normalizePhone(input, defaultCountry) !== null;
}

export function isIsraeliMobile(e164: string): boolean {
  return /^\+9725\d{8}$/.test(e164);
}

/**
 * Display form: Israeli numbers in national format (`050-123-4567`, `03-123-4567`) for `he`, and
 * international (`+972 50-123-4567`) for `en`; other countries as E.164 with a space after the
 * country code is not attempted (no metadata), so they are shown as stored.
 */
export function formatPhone(e164: string, locale: "he" | "en"): string {
  if (!e164.startsWith("+972")) return e164;
  const nsn = e164.slice(4);
  let national: string;
  if (/^[57]\d{8}$/.test(nsn)) {
    national = `${nsn.slice(0, 2)}-${nsn.slice(2, 5)}-${nsn.slice(5)}`;
  } else if (/^[2-489]\d{7}$/.test(nsn)) {
    national = `${nsn.slice(0, 1)}-${nsn.slice(1, 4)}-${nsn.slice(4)}`;
  } else {
    return e164;
  }
  return locale === "he" ? `0${national}` : `+972 ${national}`;
}

/** `tel:` href (E.164, no separators). */
export function telHref(e164: string): string {
  return `tel:${e164}`;
}

/** `https://wa.me/<digits>` link for WhatsApp (manual distance orders, spec §5.10). */
export function whatsappHref(e164: string): string {
  return `https://wa.me/${e164.replace(/^\+/, "")}`;
}
