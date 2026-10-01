import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { listCredits } from "@/server/catalog/queries";

/**
 * `/credits` (spec §6.2, §6.9): the AIC caption of every demo image ("Artist. Title, Date. The Art
 * Institute of Chicago."), the CC0 note and the font licences.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/credits">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "catalog.credits" });
  return { title: t("title") };
}

export default async function CreditsPage({
  params,
}: PageProps<"/[locale]/credits">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const [t, credits] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.credits" }),
    listCredits(locale),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-4xl">{t("title")}</h1>
      <p className="max-w-prose">{t("intro")}</p>
      {credits.length > 0 ? (
        <section aria-labelledby="images-title" className="flex flex-col gap-4">
          <h2 id="images-title" className="text-2xl">
            {t("imagesTitle")}
          </h2>
          <p className="max-w-prose text-ink-muted">{t("cc0")}</p>
          <ul className="flex flex-col gap-3">
            {credits.map((c) => (
              <li key={c.slug} className="flex flex-col">
                <span lang="en" dir="ltr" className="text-start">
                  {c.caption}
                </span>
                <span className="text-sm">
                  <Link href={paths.artwork(c.slug)}>
                    {t("viewListing")}: {c.title}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-ink-muted">
            {t("source")} (
            <a href="https://api.artic.edu/docs/" dir="ltr">
              api.artic.edu
            </a>
            )
          </p>
        </section>
      ) : null}
      <section aria-labelledby="fonts-title" className="flex flex-col gap-2">
        <h2 id="fonts-title" className="text-2xl">
          {t("fontsTitle")}
        </h2>
        <p className="max-w-prose">{t("fonts")}</p>
      </section>
    </div>
  );
}
