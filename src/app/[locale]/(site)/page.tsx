import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArtworkStatus } from "@/components/artwork/ArtworkStatus";
import { WorksGrid } from "@/components/artwork/WorksGrid";
import { JsonLd } from "@/components/site/JsonLd";
import { pageMetadata } from "@/components/site/metadata";
import { organizationJsonLd } from "@/components/site/structured-data";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import {
  getArtworkOgImage,
  getFeaturedArtwork,
  getPublicProfile,
  listArtworks,
  listSeries,
} from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * Home (spec §6.2): a featured available work as the LCP image (`fetchPriority="high"`,
 * `loading="eager"`), available works, the series, an about snippet, the commissions call to
 * action, and the Organization JSON-LD (`hasMerchantReturnPolicy`, `hasShippingService`).
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const [t, tc, featured] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.home" }),
    getTranslations({ locale, namespace: "common.meta" }),
    getFeaturedArtwork(locale),
  ]);
  const og = featured ? await getArtworkOgImage(featured.slug) : null;
  return pageMetadata({
    locale,
    path: paths.home(),
    title: `${tc("siteName")} · ${t("title")}`,
    absoluteTitle: true,
    description: t("metaDescription"),
    images: og
      ? [{ url: og, width: 1200, height: 630, alt: featured?.title }]
      : undefined,
  });
}

export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const [t, featured, works, series, profile] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.home" }),
    getFeaturedArtwork(locale),
    listArtworks(locale, { view: "available", pageSize: 7 }),
    listSeries(locale),
    getPublicProfile(locale),
  ]);
  const others = works.items
    .filter((w) => w.id !== featured?.id && w.state.kind === "available")
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
      <section className="grid items-center gap-8 md:grid-cols-[3fr_2fr]">
        {featured?.image ? (
          <Link
            href={paths.artwork(featured.slug)}
            tabIndex={-1}
            aria-hidden="true"
          >
            <Image
              src={featured.image.src}
              alt={featured.image.alt}
              width={featured.image.width}
              height={featured.image.height}
              sizes="(min-width:768px) 60vw, 100vw"
              quality={90}
              loading="eager"
              fetchPriority="high"
              placeholder={featured.image.blurDataUrl ? "blur" : "empty"}
              blurDataURL={featured.image.blurDataUrl ?? undefined}
              className="h-auto max-h-[75vh] w-full object-contain"
            />
          </Link>
        ) : null}
        <div className="flex flex-col gap-4">
          <h1 className="text-5xl">{t("title")}</h1>
          <p className="max-w-prose text-lg text-ink-muted">{t("intro")}</p>
          {featured ? (
            <div className="flex flex-col gap-1 border-s-2 border-line ps-4">
              <p className="text-sm text-ink-muted">{t("featuredLabel")}</p>
              <p className="font-serif text-xl">
                <Link href={paths.artwork(featured.slug)}>
                  {featured.title}
                </Link>
              </p>
              {/* A block wrapper: the price is an LTR <bdi>, which would align to the
                  far side as a flex item in Hebrew. */}
              <p>
                <ArtworkStatus state={featured.state} price={featured.price} />
              </p>
            </div>
          ) : null}
          <p>
            <Link href={paths.works()} className={buttonClasses("secondary")}>
              {t("allWorks")}
            </Link>
          </p>
        </div>
      </section>

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
                    className="flex aspect-square items-end justify-center"
                  >
                    <Image
                      src={s.cover.src}
                      alt=""
                      width={s.cover.width}
                      height={s.cover.height}
                      sizes="(min-width:1024px) 18vw, (min-width:768px) 30vw, 45vw"
                      quality={75}
                      placeholder={s.cover.blurDataUrl ? "blur" : "empty"}
                      blurDataURL={s.cover.blurDataUrl ?? undefined}
                      className="fade-in max-h-full w-auto object-contain"
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

      <section className="grid gap-8 border-t border-line pt-10 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="text-2xl">{t("aboutTitle")}</h2>
          <p className="max-w-prose text-ink-muted">{t("aboutBody")}</p>
          <p>
            <Link href={paths.about()}>{t("aboutLink")}</Link>
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="text-2xl">{t("commissionTitle")}</h2>
          <p className="max-w-prose text-ink-muted">{t("commissionBody")}</p>
          <p>
            <Link
              href={paths.contact("commission")}
              className={buttonClasses("secondary")}
            >
              {t("commissionCta")}
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
