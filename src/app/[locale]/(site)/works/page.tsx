import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WorksGrid } from "@/components/artwork/WorksGrid";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { listArtworks, listRecentlySold } from "@/server/catalog/queries";

/**
 * `/works` (spec §6.2; minimal M2 version, WS1 adds the filters and sorts): available works first
 * (then on hold and not for sale), 24 per page, a "Recently sold" strip (≤ 4), and the sold archive
 * at `?availability=sold`.
 */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/[locale]/works">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const sold = first((await searchParams).availability) === "sold";
  const t = await getTranslations({ locale, namespace: "catalog.works" });
  return { title: sold ? t("archiveTitle") : t("title") };
}

export default async function WorksPage({
  params,
  searchParams,
}: PageProps<"/[locale]/works">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const sold = first(query.availability) === "sold";
  const page = Math.max(1, Number.parseInt(first(query.page) ?? "1", 10) || 1);
  const t = await getTranslations({ locale, namespace: "catalog.works" });
  const [works, recentlySold] = await Promise.all([
    listArtworks(locale, { view: sold ? "sold" : "current", page }),
    sold ? Promise.resolve([]) : listRecentlySold(locale),
  ]);
  const pages = Math.max(1, Math.ceil(works.total / works.pageSize));
  const pageHref = (p: number) =>
    paths.works({
      availability: sold ? "sold" : undefined,
      page: p > 1 ? p : undefined,
    });

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl">{sold ? t("archiveTitle") : t("title")}</h1>
        <p className="max-w-prose text-ink-muted">
          {sold ? t("archiveIntro") : t("intro")}
        </p>
        <p className="text-sm text-ink-muted">
          {t("count", { count: works.total })}
        </p>
      </header>

      {works.items.length > 0 ? (
        <WorksGrid works={works.items} priorityFirst />
      ) : (
        <p>{t("empty")}</p>
      )}

      {pages > 1 ? (
        <nav aria-label={t("pagination")} className="flex items-center gap-4">
          {page > 1 ? (
            <Link href={pageHref(page - 1)}>{t("previous")}</Link>
          ) : null}
          <span className="text-ink-muted">{t("page", { page, pages })}</span>
          {page < pages ? (
            <Link href={pageHref(page + 1)}>{t("next")}</Link>
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
