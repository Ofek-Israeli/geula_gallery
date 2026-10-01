import "../globals.css";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { DemoBanner } from "@/components/site/DemoBanner";
import { dirOf, routing } from "@/i18n/routing";
import { env } from "@/server/env";
import { fontVariables } from "../fonts";

/**
 * The ONLY root layout (there is no src/app/layout.tsx; spec §2.3). Classic fully dynamic
 * rendering (spec §1.4, §2.4): availability, price and "Sold" are read on every request.
 */
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  themeColor: "#fbfaf7",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export async function generateMetadata({
  params,
}: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "common.meta" });
  return {
    metadataBase: new URL(env.APP_URL),
    title: { default: t("siteName"), template: t("titleTemplate") },
    description: t("description"),
    applicationName: t("siteName"),
    // Demo deployments are noindex via the X-Robots-Tag header as well (next.config.ts, §6.9).
    ...(env.DEMO_MODE ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  return (
    <html lang={locale} dir={dirOf(locale)} className={fontVariables}>
      <body className="flex min-h-dvh flex-col bg-paper text-ink antialiased">
        <NextIntlClientProvider>
          {env.DEMO_MODE ? <DemoBanner locale={locale} /> : null}
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
