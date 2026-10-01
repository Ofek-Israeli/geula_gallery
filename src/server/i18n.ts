import "server-only";
import { createTranslator } from "use-intl/core";
import type { EmailT } from "@/emails/types";
import { getMessagesFor } from "@/i18n/namespaces";
import type { Locale } from "@/lib/locale";
import { log } from "@/server/log";

/**
 * Translations outside Next (spec §2.2): emails, documents and jobs use `createTranslator` from
 * `use-intl/core` (never next-intl), with the same merged messages as the site
 * (`src/i18n/namespaces.ts`). Keys are `<namespace>.<path>`, e.g. `emails-core.greeting`.
 */
export const TIME_ZONE = "Asia/Jerusalem";

const cache = new Map<Locale, ReturnType<typeof makeTranslator>>();

function makeTranslator(locale: Locale) {
  return createTranslator({
    locale,
    messages: getMessagesFor(locale),
    timeZone: TIME_ZONE,
    onError: (error) => {
      // A missing key renders as `<namespace>.<key>`; log it instead of throwing.
      log.warn("i18n.message_error", { locale, code: error.code });
    },
  });
}

/** The typed translator for a locale (keys checked against the Hebrew messages). */
export function getTranslator(locale: Locale) {
  let t = cache.get(locale);
  if (!t) {
    t = makeTranslator(locale);
    cache.set(locale, t);
  }
  return t;
}

/** String-keyed translator for templates whose keys are composed at runtime. */
export function getUntypedTranslator(locale: Locale): EmailT {
  const t = getTranslator(locale) as unknown as (
    key: string,
    values?: Record<string, string | number | Date>,
  ) => string;
  return (key, values) => t(key, values);
}
