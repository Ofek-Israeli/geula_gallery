import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { pageMetadata } from "@/components/site/metadata";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";

/**
 * `/credits` (spec §6.2): the font licences. The artworks and their photographs are the
 * painter's own, so they need no credit lines.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/credits">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "catalog.credits" });
  return pageMetadata({
    locale,
    path: paths.credits(),
    title: t("title"),
    description: t("intro"),
  });
}

export default async function CreditsPage({
  params,
}: PageProps<"/[locale]/credits">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = await getTranslations({ locale, namespace: "catalog.credits" });
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-4xl">{t("title")}</h1>
      <p className="max-w-prose">{t("intro")}</p>
      <section aria-labelledby="fonts-title" className="flex flex-col gap-2">
        <h2 id="fonts-title" className="text-2xl">
          {t("fontsTitle")}
        </h2>
        <p className="max-w-prose">{t("fonts")}</p>
      </section>
    </div>
  );
}
