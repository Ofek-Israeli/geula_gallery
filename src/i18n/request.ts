import { notFound } from "next/navigation";
import { locale as rootLocale } from "next/root-params";
import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { getMessagesFor } from "./namespaces";
import { routing, TIME_ZONE } from "./routing";

/**
 * Per-request i18n config (spec §6.4).
 *
 * Locale resolution order:
 *  1. an explicit locale (`getTranslations({ locale })`); Server Actions and Route Handlers always
 *     pass one, because every action and route input carries `locale` (spec §2.2);
 *  2. the `[locale]` root param (`next/root-params`), in Server Components;
 *  3. the locale next-intl's proxy resolved for this request (fallback for contexts where root
 *     params are unavailable, e.g. Server Actions that forgot to pass `locale`).
 * An unknown locale is a 404.
 */
export default getRequestConfig(async ({ locale, requestLocale }) => {
  let resolved: string | undefined = locale;
  if (!resolved) {
    try {
      resolved = await rootLocale();
    } catch {
      // next/root-params throws outside Server Components (Server Actions, Route Handlers).
      resolved = undefined;
    }
  }
  resolved ??= await requestLocale;
  if (!hasLocale(routing.locales, resolved)) notFound();

  return {
    locale: resolved,
    timeZone: TIME_ZONE,
    messages: getMessagesFor(resolved),
  };
});
