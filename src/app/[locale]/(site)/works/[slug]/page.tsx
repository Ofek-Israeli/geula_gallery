import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArtworkFacts } from "@/components/artwork/ArtworkFacts";
import { LiveBuyBox } from "@/components/artwork/LiveBuyBox";
import { Badge } from "@/components/ui/Badge";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";
import { getArtworkPage, getDeliveryEstimates } from "@/server/catalog/queries";

/**
 * `/works/[slug]` (spec §6.3; minimal M2 version): breadcrumbs, the uncropped image with its AIC
 * credit, title, the live buy box (price or status, Buy now → checkout, delivery estimates),
 * facts in cm and inches, and the description. WS1 adds the gallery strip, lightbox, JSON-LD,
 * the sticky mobile bar and full metadata.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/works/[slug]">): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const data = await getArtworkPage(locale, slug);
  if (!data) return {};
  const { artwork } = data;
  return {
    title: artwork.title,
    description: artwork.description.slice(0, 160),
    alternates: {
      canonical: localePath(locale, paths.artwork(slug)),
      languages: {
        he: localePath("he", paths.artwork(slug)),
        en: localePath("en", paths.artwork(slug)),
        "x-default": localePath("he", paths.artwork(slug)),
      },
    },
    openGraph: artwork.ogImage
      ? { images: [{ url: artwork.ogImage, width: 1200, height: 630 }] }
      : undefined,
  };
}

export default async function ArtworkPage({
  params,
}: PageProps<"/[locale]/works/[slug]">) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const data = await getArtworkPage(locale, slug);
  if (!data) notFound();
  const { artwork, shipSpec } = data;
  const [delivery, t, tc] = await Promise.all([
    getDeliveryEstimates(locale, shipSpec),
    getTranslations({ locale, namespace: "artwork" }),
    getTranslations({ locale, namespace: "common" }),
  ]);
  const main = artwork.images[0] ?? null;

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label={tc("breadcrumbs")} className="text-sm">
        <ol className="flex flex-wrap gap-2 text-ink-muted">
          <li>
            <Link href={paths.home()}>{t("breadcrumbs.home")}</Link>
            <span aria-hidden="true" className="ms-2">
              /
            </span>
          </li>
          <li>
            <Link href={paths.works()}>{t("breadcrumbs.works")}</Link>
            <span aria-hidden="true" className="ms-2">
              /
            </span>
          </li>
          <li aria-current="page" className="text-ink">
            {artwork.title}
          </li>
        </ol>
      </nav>

      <div className="grid gap-10 md:grid-cols-[3fr_2fr]">
        <figure className="flex flex-col gap-2">
          {main ? (
            <Image
              src={main.src}
              alt={main.alt}
              width={main.width}
              height={main.height}
              sizes="(min-width:768px) 60vw, 100vw"
              quality={90}
              loading="eager"
              fetchPriority="high"
              placeholder={main.blurDataUrl ? "blur" : "empty"}
              blurDataURL={main.blurDataUrl ?? undefined}
              className="h-auto max-h-[85vh] w-full object-contain"
            />
          ) : null}
          {main?.creditLine ? (
            <figcaption className="text-sm text-ink-muted">
              {t("credit", { caption: main.creditLine })}
            </figcaption>
          ) : null}
        </figure>

        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            {artwork.isDemo ? (
              <p>
                <Badge>{t("demo")}</Badge>
              </p>
            ) : null}
            <h1 className="text-4xl">{artwork.title}</h1>
            <p className="text-ink-muted">
              {[artwork.year, artwork.mediumText].filter(Boolean).join(" · ")}
            </p>
          </header>
          <LiveBuyBox
            artwork={artwork}
            estimates={delivery.zones}
            pickupFree={delivery.pickupFree}
          />
          <section
            aria-labelledby="facts-title"
            className="flex flex-col gap-3"
          >
            <h2 id="facts-title" className="text-2xl">
              {t("facts.title")}
            </h2>
            <ArtworkFacts
              artwork={artwork}
              packagingType={shipSpec.packagingType}
            />
          </section>
          {artwork.description ? (
            <section
              aria-labelledby="description-title"
              className="flex flex-col gap-2"
            >
              <h2 id="description-title" className="text-2xl">
                {t("description")}
              </h2>
              <p className="max-w-prose whitespace-pre-line">
                {artwork.description}
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
