"use client";

import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";

/** Switches language while keeping the path and query (spec §6.4). */
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useTranslations("common.language");
  const locale = useLocale() as AppLocale;
  const other: AppLocale = locale === "he" ? "en" : "he";
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  return (
    <Link
      href={query ? `${pathname}?${query}` : pathname}
      locale={other}
      lang={other}
      hrefLang={other}
      className={className}
      aria-label={`${t("label")}: ${t(other)}`}
    >
      {t("switchTo")}
    </Link>
  );
}
