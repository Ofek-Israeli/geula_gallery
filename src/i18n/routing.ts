import { defineRouting } from "next-intl/routing";

// Minimal routing definition (M1 step 4 placeholder so the next-intl plugin can load).
// M1 step 7 completes i18n: navigation helpers, namespaces and the proxy.
export const routing = defineRouting({
  locales: ["he", "en"],
  defaultLocale: "he",
  localePrefix: "always",
});

export type AppLocale = (typeof routing.locales)[number];
