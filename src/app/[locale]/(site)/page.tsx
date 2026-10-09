import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WorksGrid } from "@/components/artwork/WorksGrid";
import { ArtistBio } from "@/components/site/ArtistBio";
import { JsonLd } from "@/components/site/JsonLd";
import { pageMetadata } from "@/components/site/metadata";
import { QuoteHero } from "@/components/site/QuoteHero";
import { organizationJsonLd } from "@/components/site/structured-data";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import {
  getArtworkOgImage,
  getHeroArtwork,
  getPublicProfile,
  listArtworks,
  listSeries,
} from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * Home: a quote about colour over "By the Lake" (the LCP image, `fetchPriority="high"`), the
 * artist's biography as the page's `<h1>`, available works, the series, and the Organization
 * JSON-LD (`hasMerchantReturnPolicy`, `hasShippingService`). The painter chose the opening (after
 * alonyaffe.co.il) in place of spec §6.2's featured split. She does not take commissions, so the
 * site never offers them.
 */

export async function generateMetadata({
  params,
}: PageProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const [t, tc, hero] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.home" }),
    getTranslations({ locale, namespace: "common.meta" }),
    getHeroArtwork(locale),
  ]);
  const og = hero ? await getArtworkOgImage(hero.slug) : null;
  return pageMetadata({
    locale,
    path: paths.home(),
    title: `${tc("siteName")} · ${t("title")}`,
    absoluteTitle: true,
    description: t("metaDescription"),
    images: og ? [{ ...og, alt: hero?.title }] : undefined,
  });
}

export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const [t, hero, works, series, profile] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.home" }),
    getHeroArtwork(locale),
    listArtworks(locale, { view: "available", pageSize: 7 }),
    listSeries(locale),
    getPublicProfile(locale),
  ]);
  const others = works.items
    .filter((w) => w.id !== hero?.id && w.state.kind === "available")
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-16">
      <JsonLd
        data={organizationJsonLd({
          base: env.APP_URL,
          locale,
          name: profile.tradeName,
          email: profile.email,
          telephone: profile.phoneIntl,
        })}
      />
      <QuoteHero work={hero} />

      <div className="flex flex-col items-center gap-8">
        <ArtistBio headingLevel={1} centred />
        <p>
          <Link href={paths.works()} className={buttonClasses("primary")}>
            {t("allWorks")}
          </Link>
        </p>
      </div>

      {others.length > 0 ? (
        <section
          aria-labelledby="available-title"
          className="flex flex-col gap-6"
        >
          <h2 id="available-title" className="text-3xl">
            {t("availableTitle")}
          </h2>
          <WorksGrid works={others} headingLevel={3} />
          <p>
            <Link href={paths.works({ availability: "available" })}>
              {t("allWorks")}
            </Link>
          </p>
        </section>
      ) : null}

      {series.length > 0 ? (
        <section aria-labelledby="series-title" className="flex flex-col gap-6">
          <h2 id="series-title" className="text-3xl">
            {t("seriesTitle")}
          </h2>
          <ul className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-5">
            {series.map((s) => (
              <li key={s.slug} className="flex flex-col gap-2">
                {s.cover ? (
                  <Link
                    href={paths.works({ series: s.slug })}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="relative block aspect-square"
                  >
                    {/* `fill` keeps every cover inside the same square, so a portrait painting
                        never grows its card or spills over the series name. `style` (not a
                        class) so the blur placeholder is letterboxed the same way. */}
                    <Image
                      src={s.cover.src}
                      alt=""
                      fill
                      sizes="(min-width:1024px) 18vw, (min-width:768px) 30vw, 45vw"
                      quality={75}
                      placeholder={s.cover.blurDataUrl ? "blur" : "empty"}
                      blurDataURL={s.cover.blurDataUrl ?? undefined}
                      className="fade-in"
                      style={{ objectFit: "contain", objectPosition: "bottom" }}
                    />
                  </Link>
                ) : null}
                <h3 className="font-serif text-lg leading-snug">
                  <Link href={paths.works({ series: s.slug })}>{s.name}</Link>
                </h3>
                <p className="text-sm text-ink-muted">
                  {t("seriesCount", { count: s.count })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
