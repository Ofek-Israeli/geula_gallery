import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Placeholder request config (M1 step 4). M1 step 7 replaces `messages` with the merged
// namespaces from `namespaces.ts`.
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;
  return { locale, messages: {} };
});
