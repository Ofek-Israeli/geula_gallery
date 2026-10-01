import type { Messages } from "./namespaces";
import type { AppLocale } from "./routing";

// Typed message keys and locales for next-intl / use-intl (spec §6.4).
declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
    Messages: Messages;
  }
}
