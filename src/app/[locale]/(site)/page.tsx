import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArtworkStatus } from "@/components/artwork/ArtworkStatus";
import { WorksGrid } from "@/components/artwork/WorksGrid";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { getFeaturedArtwork, listArtworks } from "@/server/catalog/queries";

/**
 * Home (spec §6.2; minimal M2 version, WS1 adds series, Organization JSON-LD and polish): a featured
 * available work as the LCP image (`fetchPriority="high"`, `loading="eager"`), available works, an
 * about snippet and the commissions call to action.
 */
export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = await getTranslations({ locale, namespace: "catalog.home" });
  const [featured, works] = await Promise.all([
    getFeaturedArtwork(locale),
    listArtworks(locale, { pageSize: 7 }),
  ]);
  const others = works.items
    .filter((w) => w.id !== featured?.id && w.state.kind === "available")
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-16">
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
              <ArtworkStatus state={featured.state} price={featured.price} />
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
            <Link href={paths.works()}>{t("allWorks")}</Link>
          </p>
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
