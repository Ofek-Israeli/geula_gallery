import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE_VALUE, isLocale, LOCALE_VALUES } from "@/lib/locale";

/**
 * Locale routing (spec §6.2, §6.4): `/he` (RTL, default) and `/en` (LTR), always prefixed.
 * `/` redirects by Accept-Language (next-intl middleware in `src/proxy.ts`).
 * Frozen after M1 (spec §9.4).
 */
export const routing = defineRouting({
  locales: LOCALE_VALUES,
  defaultLocale: DEFAULT_LOCALE_VALUE,
  localePrefix: "always",
});

export type AppLocale = (typeof routing.locales)[number];

export const LOCALES = routing.locales;
export const DEFAULT_LOCALE: AppLocale = routing.defaultLocale;

export const isAppLocale: (value: unknown) => value is AppLocale = isLocale;

/** Writing direction of a locale. Never mirror artworks, prices, dimensions or phones (§6.4). */
export function dirOf(locale: AppLocale): "rtl" | "ltr" {
  return locale === "he" ? "rtl" : "ltr";
}

/** Intl locale used for server-side formatting (§6.4): he-IL / en-IL, Asia/Jerusalem. */
export function intlLocaleOf(locale: AppLocale): "he-IL" | "en-IL" {
  return locale === "he" ? "he-IL" : "en-IL";
}

export const TIME_ZONE = "Asia/Jerusalem";
