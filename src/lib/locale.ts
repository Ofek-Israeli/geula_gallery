/**
 * The site's locales as plain data (spec §6.4), importable from any layer. `src/i18n/routing.ts`
 * builds next-intl routing from these; `src/server/**` uses them without importing next-intl.
 */
export const LOCALE_VALUES = ["he", "en"] as const;
export type Locale = (typeof LOCALE_VALUES)[number];
export const DEFAULT_LOCALE_VALUE: Locale = "he";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (LOCALE_VALUES as readonly string[]).includes(value)
  );
}
