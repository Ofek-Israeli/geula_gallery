/**
 * Writing-script checks (spec §4.4, §6.4): international shipping addresses must be Latin script
 * (carriers print them on labels and customs forms); Hebrew is allowed domestically. Also a
 * first-strong direction guess for user text rendered with `dir="auto"` fallbacks.
 */

/** The spec's rule: Latin letters, digits, punctuation and spaces only. */
export const LATIN_TEXT_RE = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u;

const HEBREW_RE = /\p{Script=Hebrew}/u;
const ARABIC_RE = /\p{Script=Arabic}/u;
const STRONG_RE = /[\p{Script=Latin}\p{Script=Hebrew}\p{Script=Arabic}]/u;

/** True when `text` is non-empty and uses only Latin letters, digits, punctuation and spaces. */
export function isLatinText(text: string): boolean {
  return LATIN_TEXT_RE.test(text);
}

export function hasHebrew(text: string): boolean {
  return HEBREW_RE.test(text);
}

/**
 * Address fields for a destination: abroad every non-empty field must be Latin; domestic (IL)
 * addresses accept any script. Returns the names of offending fields.
 */
export function nonLatinFields<
  T extends Record<string, string | null | undefined>,
>(fields: T, destinationCountry: string): (keyof T)[] {
  if (destinationCountry === "IL") return [];
  return (Object.keys(fields) as (keyof T)[]).filter((k) => {
    const v = fields[k]?.trim();
    return !!v && !isLatinText(v);
  });
}

/** Direction of the first strong character (`rtl` for Hebrew/Arabic), else `fallback`. */
export function textDirection(
  text: string,
  fallback: "ltr" | "rtl" = "ltr",
): "ltr" | "rtl" {
  const m = STRONG_RE.exec(text);
  if (!m) return fallback;
  return HEBREW_RE.test(m[0]) || ARABIC_RE.test(m[0]) ? "rtl" : "ltr";
}
