import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";

/**
 * Admin shell (spec §6.10): noindex. `X-Robots-Tag` and `Cache-Control: no-store` also come from
 * next.config.ts. Authorization is NOT done here: login lives below this layout, and every admin
 * page calls `requireAdmin` itself.
 */
export async function generateMetadata({
  params,
}: LayoutProps<"/[locale]/admin">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.meta" });
  return {
    title: { default: t("title"), template: `%s · ${t("title")}` },
    robots: { index: false, follow: false },
  };
}

export default function AdminLayout({
  children,
}: LayoutProps<"/[locale]/admin">) {
  return children;
}
