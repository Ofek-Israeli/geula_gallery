import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { ArtworkFacts } from "@/components/artwork/ArtworkFacts";
import { ArtworkGallery } from "@/components/artwork/ArtworkGallery";
import { useStatusText } from "@/components/artwork/ArtworkStatus";
import { primaryAction, shownPriceMinor } from "@/components/artwork/buy-box";
import { BUY_BOX_ID, LiveBuyBox } from "@/components/artwork/LiveBuyBox";
import { StickyBuyBar } from "@/components/artwork/StickyBuyBar";
import { JsonLd } from "@/components/site/JsonLd";
import { metaDescription, pageMetadata } from "@/components/site/metadata";
import {
  artworkJsonLd,
  breadcrumbJsonLd,
  organizationId,
} from "@/components/site/structured-data";
import { Accordion } from "@/components/ui/Accordion";
import { Badge } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import type { ArtworkDetailDTO } from "@/lib/catalog";
import { isLocale, type Locale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";
import {
  getArtworkPage,
  getDeliveryEstimates,
  getPublicProfile,
} from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * `/works/[slug]` (spec §6.3): breadcrumbs; the gallery (mobile scroll-snap strip with a counter,
 * desktop main image with thumbnails, lightbox); title; the live buy box (price or status, Buy
 * now / Ask, delivery from ₪X and zone estimates, DAP note, trust row with "insured" only when
 * backed); facts in cm and inches; the description; `<details>` accordions (cancellation and
 * returns, duties, packing); the mobile sticky bar; VisualArtwork + Product and BreadcrumbList
 * JSON-LD; the AIC credit under demo images, bidi-isolated.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/works/[slug]">): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const data = await getArtworkPage(locale, slug);
  if (!data) return {};
  const { artwork } = data;
  return pageMetadata({
    locale,
    path: paths.artwork(slug),
    title: artwork.title,
    description: metaDescription(
      artwork.description ||
        [artwork.title, artwork.year, artwork.mediumText]
          .filter(Boolean)
          .join(" · "),
    ),
    type: "article",
    images: artwork.ogImage
      ? [
          {
            url: artwork.ogImage,
            width: 1200,
            height: 630,
            alt: artwork.images[0]?.alt ?? artwork.title,
          },
        ]
      : undefined,
  });
}

/**
 * The AIC credit (English) under a Hebrew or English page: the caption is its own `lang="en"`
 * LTR inline block, so when it wraps, its lines wrap as an English paragraph instead of mixing
 * with the Hebrew label (bidi reordering across line breaks; WCAG 3.1.2 language of parts).
 */
function CreditLine({
  label,
  caption,
  licence,
}: {
  label: string;
  caption: string;
  licence: string;
}) {
  return (
    <>
      {label}{" "}
      <span lang="en" dir="ltr" className="inline-block text-start">
        {caption} {licence}
      </span>
    </>
  );
}

function StickyBar({
  artwork,
  locale,
}: {
  artwork: ArtworkDetailDTO;
  locale: Locale;
}) {
  const statusText = useStatusText();
  const t = useTranslations("artwork.buy");
  const action = primaryAction(artwork);
  const shown = shownPriceMinor(artwork);
  return (
    <StickyBuyBar
      title={artwork.title}
      priceOrStatus={
        shown !== null ? (
          <Price amountMinor={shown} currency="ILS" locale={locale} />
        ) : (
          statusText(artwork.state)
        )
      }
      href={
        action.kind === "buy"
          ? paths.checkout(artwork.slug)
          : paths.artworkRequest(artwork.slug, action.request)
      }
      actionLabel={action.kind === "buy" ? t("buyNow") : t(action.label)}
      primary={action.kind === "buy" || action.label === "requestQuote"}
      watchId={BUY_BOX_ID}
    />
  );
}

export default async function ArtworkPage({
  params,
}: PageProps<"/[locale]/works/[slug]">) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const data = await getArtworkPage(locale, slug);
  if (!data) notFound();
  const { artwork, shipSpec, seo } = data;
  const [delivery, profile, t, tb] = await Promise.all([
    getDeliveryEstimates(locale, shipSpec),
    getPublicProfile(locale),
    getTranslations({ locale, namespace: "artwork" }),
    getTranslations({ locale, namespace: "common" }),
  ]);
  const base = env.APP_URL;
  const credit = artwork.images[0]?.creditLine ?? artwork.creditLine;

  return (
    <div className="flex flex-col gap-8 max-md:pbe-24">
      <JsonLd
        data={[
          artworkJsonLd({
            base,
            locale,
            artwork,
            medium: seo.medium,
            surface: seo.surface,
            artistName: profile.artistName,
            images: artwork.images.map((i) => i.src),
            liveStore: !env.DEMO_MODE,
            sellerId: organizationId(base),
          }),
          breadcrumbJsonLd(base, [
            {
              name: t("breadcrumbs.home"),
              path: localePath(locale, paths.home()),
            },
            {
              name: t("breadcrumbs.works"),
              path: localePath(locale, paths.works()),
            },
            {
              name: artwork.title,
              path: localePath(locale, paths.artwork(slug)),
            },
          ]),
        ]}
      />
      <nav aria-label={tb("breadcrumbs")} className="text-sm">
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
        <ArtworkGallery
          title={artwork.title}
          images={artwork.images.map((i) => ({
            id: i.id,
            src: i.src,
            width: i.width,
            height: i.height,
            alt: i.alt,
            blurDataUrl: i.blurDataUrl,
          }))}
          caption={
            credit ? (
              <CreditLine
                label={t("creditLabel")}
                caption={credit}
                licence={t("creditLicence")}
              />
            ) : undefined
          }
        />

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
          <section aria-labelledby="more-title" className="flex flex-col">
            <h2 id="more-title" className="sr-only">
              {t("more.title")}
            </h2>
            <Accordion summary={t("more.returnsTitle")}>
              <p className="max-w-prose">{t("more.returnsBody")}</p>
              <p className="mt-2 text-sm">
                <Link href={paths.legal("returns")}>
                  {t("more.returnsLink")}
                </Link>
              </p>
            </Accordion>
            {artwork.shipsInternationally && !artwork.localPickupOnly ? (
              <Accordion summary={t("more.dutiesTitle")}>
                <p className="max-w-prose">{t("more.dutiesBody")}</p>
                <p className="mt-2 text-sm">
                  <Link href={paths.legal("shipping")}>
                    {t("more.dutiesLink")}
                  </Link>
                </p>
              </Accordion>
            ) : null}
            <Accordion summary={t("more.careTitle")}>
              <p className="max-w-prose">{t("more.careBody")}</p>
              {artwork.coaIncluded ? (
                <p className="max-w-prose">{t("more.coaBody")}</p>
              ) : null}
              {artwork.readyToHang ? (
                <p className="max-w-prose">{t("more.readyToHangBody")}</p>
              ) : null}
            </Accordion>
          </section>
        </div>
      </div>
      <StickyBar artwork={artwork} locale={locale} />
    </div>
  );
}
