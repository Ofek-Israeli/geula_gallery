import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WorksFilters } from "@/components/artwork/WorksFilters";
import { WorksGrid } from "@/components/artwork/WorksGrid";
import {
  hasFilters,
  parseWorksParams,
  priceBounds,
  worksHref,
  worksQuery,
} from "@/components/artwork/works-params";
import { JsonLd } from "@/components/site/JsonLd";
import { pageMetadata } from "@/components/site/metadata";
import { breadcrumbJsonLd } from "@/components/site/structured-data";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";
import {
  listArtworks,
  listRecentlySold,
  listSeries,
} from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * `/works` (spec §6.2): URL-synced filters (availability, series, size, orientation, price band)
 * and sorts (featured, newest, price, size), 24 per page. The default view lists available works
 * first, then on hold and not for sale, with a "Recently sold" strip (≤ 4);
 * `?availability=sold` is the archive.
 */
export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/[locale]/works">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const p = parseWorksParams(await searchParams);
  const sold = p.availability === "sold";
  const t = await getTranslations({ locale, namespace: "catalog.works" });
  // Filtered and sorted variants canonicalize to the plain list (or the archive).
  const path = sold ? paths.works({ availability: "sold" }) : paths.works();
  return pageMetadata({
    locale,
    path,
    title: sold ? t("archiveTitle") : t("title"),
    description: sold ? t("archiveIntro") : t("intro"),
  });
}

export default async function WorksPage({
  params,
  searchParams,
}: PageProps<"/[locale]/works">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const p = parseWorksParams(await searchParams);
  const sold = p.availability === "sold";
  const view = sold
    ? "sold"
    : p.availability === "available"
      ? "available"
      : "current";
  const filtered = hasFilters(p);
  const [t, tb, works, series, recentlySold] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.works" }),
    getTranslations({ locale, namespace: "artwork.breadcrumbs" }),
    listArtworks(locale, {
      view,
      page: p.page,
      seriesSlug: p.series,
      sizeBucket: p.size,
      orientation: p.orientation,
      ...priceBounds(p.price),
      sort: p.sort,
    }),
    listSeries(locale),
    sold || filtered || p.page > 1
      ? Promise.resolve([])
      : listRecentlySold(locale),
  ]);
  const pages = Math.max(1, Math.ceil(works.total / works.pageSize));
  const title = sold ? t("archiveTitle") : t("title");

  return (
    <div className="flex flex-col gap-8">
      <JsonLd
        data={breadcrumbJsonLd(env.APP_URL, [
          { name: tb("home"), path: localePath(locale, paths.home()) },
          { name: tb("works"), path: localePath(locale, paths.works()) },
        ])}
      />
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl">{title}</h1>
        <p className="max-w-prose text-ink-muted">
          {sold ? t("archiveIntro") : t("intro")}
        </p>
      </header>

      <WorksFilters
        key={JSON.stringify(worksQuery(p))}
        action={localePath(locale, paths.works())}
        params={p}
        series={series.map((s) => ({ slug: s.slug, name: s.name }))}
      />

      <p className="text-sm text-ink-muted" data-testid="works-count">
        {filtered
          ? t("countFiltered", { count: works.total })
          : t("count", { count: works.total })}
      </p>

      {works.items.length > 0 ? (
        <WorksGrid works={works.items} priorityFirst label={title} />
      ) : (
        <div className="flex flex-col gap-2">
          <p>{filtered ? t("emptyFiltered") : t("empty")}</p>
          {filtered ? (
            <p>
              <Link href={paths.works(sold ? { availability: "sold" } : {})}>
                {t("clearFilters")}
              </Link>
            </p>
          ) : null}
        </div>
      )}

      {pages > 1 ? (
        <nav aria-label={t("pagination")} className="flex items-center gap-4">
          {p.page > 1 ? (
            <Link
              href={worksHref(p, { page: p.page - 1 })}
              rel="prev"
              className="inline-flex min-h-11 items-center"
            >
              {t("previous")}
            </Link>
          ) : null}
          <span className="text-ink-muted">
            {t("page", { page: p.page, pages })}
          </span>
          {p.page < pages ? (
            <Link
              href={worksHref(p, { page: p.page + 1 })}
              rel="next"
              className="inline-flex min-h-11 items-center"
            >
              {t("next")}
            </Link>
          ) : null}
        </nav>
      ) : null}

      {recentlySold.length > 0 ? (
        <section
          aria-labelledby="recently-sold"
          className="flex flex-col gap-6 border-t border-line pt-8"
        >
          <h2 id="recently-sold" className="text-2xl">
            {t("recentlySold")}
          </h2>
          <WorksGrid works={recentlySold} headingLevel={3} />
        </section>
      ) : null}

      <p>
        {sold ? (
          <Link href={paths.works()}>{t("backToCurrent")}</Link>
        ) : (
          <Link href={paths.works({ availability: "sold" })}>
            {t("viewArchive")}
          </Link>
        )}
      </p>
    </div>
  );
}
