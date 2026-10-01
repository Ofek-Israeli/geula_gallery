import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { JsonLd } from "@/components/site/JsonLd";
import { pageMetadata } from "@/components/site/metadata";
import { personJsonLd } from "@/components/site/structured-data";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { getPublicProfile } from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * `/about` (spec §6.2): the artist, the studio, links to the works and contact, and the Person
 * JSON-LD. The biography is placeholder copy until the `site_content` editor (P1) exists.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/about">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "catalog.about" });
  return pageMetadata({
    locale,
    path: paths.about(),
    title: t("title"),
    description: t("metaDescription"),
  });
}

export default async function AboutPage({
  params,
}: PageProps<"/[locale]/about">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const [t, profile] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.about" }),
    getPublicProfile(locale),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <JsonLd
        data={personJsonLd({
          base: env.APP_URL,
          locale,
          name: profile.artistName,
          jobTitle: t("jobTitle"),
        })}
      />
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl">{t("title")}</h1>
        <p className="max-w-prose text-lg">{t("intro")}</p>
      </header>
      <p className="max-w-prose">{t("body")}</p>
      {env.DEMO_MODE ? (
        <p className="max-w-prose border-s-2 border-hold ps-4 text-sm text-ink-muted">
          {t("demoNote")}
        </p>
      ) : null}
      <section aria-labelledby="studio-title" className="flex flex-col gap-2">
        <h2 id="studio-title" className="text-2xl">
          {t("studioTitle")}
        </h2>
        <p className="max-w-prose">{t("studioBody")}</p>
      </section>
      <p className="flex flex-wrap gap-4">
        <Link href={paths.works()} className={buttonClasses("primary")}>
          {t("worksLink")}
        </Link>
        <Link href={paths.contact()} className={buttonClasses("secondary")}>
          {t("contactLink")}
        </Link>
      </p>
    </div>
  );
}
