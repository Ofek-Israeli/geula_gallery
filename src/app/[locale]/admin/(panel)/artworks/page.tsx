import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ARTWORK_STATUS_TONE } from "@/components/admin/tones";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { formatTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths, withQuery } from "@/lib/routes";
import {
  ADMIN_ARTWORKS_PAGE_SIZE,
  type AdminArtworkFilter,
  listAdminArtworks,
} from "@/server/admin/catalog";
import { requireAdmin } from "@/server/next/guards";

const FILTERS = [
  "all",
  "draft",
  "available",
  "on_hold",
  "sold",
  "not_for_sale",
] as const satisfies readonly AdminArtworkFilter[];

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/artworks">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-catalog.list" });
  return { title: t("title") };
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** `/admin/artworks` (spec §6.10): list with filters, search and quick links. */
export default async function AdminArtworksPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/artworks">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f === one(sp.filter)) ?? "all";
  const q = one(sp.q)?.slice(0, 80) ?? "";
  const page = Number.parseInt(one(sp.page) ?? "1", 10) || 1;
  const t = await getTranslations({ locale, namespace: "admin-catalog" });
  const tc = await getTranslations({ locale, namespace: "admin-shell.common" });
  const { rows, total } = await listAdminArtworks(ctx, { filter, q, page });
  const pages = Math.max(1, Math.ceil(total / ADMIN_ARTWORKS_PAGE_SIZE));
  const href = (extra: Record<string, string | number | undefined>) =>
    withQuery(paths.admin.artworks(), {
      filter: filter === "all" ? undefined : filter,
      q: q || undefined,
      ...extra,
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl">{t("list.title")}</h1>
        <Link href={paths.admin.newArtwork()} className={buttonClasses()}>
          {t("list.new")}
        </Link>
      </div>
      {one(sp.deleted) ? <p role="status">{t("list.deleted")}</p> : null}
      <nav aria-label={t("list.filters")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={href({
              filter: f === "all" ? undefined : f,
              page: undefined,
            })}
            aria-current={filter === f ? "page" : undefined}
            className={buttonClasses(
              filter === f ? "secondary" : "ghost",
              "sm",
            )}
          >
            {t(`list.filter.${f}`)}
          </Link>
        ))}
      </nav>
      <search>
        <form method="get" className="flex max-w-xl flex-wrap items-end gap-2">
          {filter !== "all" ? (
            <input type="hidden" name="filter" value={filter} />
          ) : null}
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="artworks-q" className="font-medium">
              {t("list.searchLabel")}
            </label>
            <Input id="artworks-q" name="q" type="search" defaultValue={q} />
          </div>
          <button type="submit" className={buttonClasses("secondary")}>
            {tc("search")}
          </button>
        </form>
      </search>
      <p className="text-sm text-ink-muted">
        {t("list.count", { count: total })}
      </p>
      {rows.length === 0 ? (
        <p>{t("list.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-4 py-3"
              data-testid="admin-artwork-row"
            >
              {r.thumb ? (
                // biome-ignore lint/performance/noImgElement: admin thumbnails need no optimisation
                <img
                  src={r.thumb}
                  alt=""
                  width={64}
                  height={64}
                  className="size-16 object-contain"
                />
              ) : (
                <span className="size-16 border border-dashed border-line" />
              )}
              <div className="flex min-w-48 flex-1 flex-col gap-1">
                <Link href={paths.admin.artwork(r.id)} className="font-medium">
                  {locale === "he" ? r.titleHe : r.titleEn}
                </Link>
                <span className="text-sm text-ink-muted">
                  <bdi dir="ltr">{r.inventoryNumber}</bdi> ·{" "}
                  <bdi dir="ltr">{r.slug}</bdi>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={ARTWORK_STATUS_TONE[r.saleStatus]}>
                  <span data-testid="admin-artwork-status">
                    {t(`status.${r.saleStatus}`)}
                  </span>
                </Badge>
                <Badge>
                  {r.isPublished ? t("list.published") : t("list.draft")}
                </Badge>
                {r.isDemo ? <Badge>{tc("demo")}</Badge> : null}
                {r.reservedUntil && r.reservedUntil.getTime() > Date.now() ? (
                  <Badge tone="hold">
                    {t("list.reservedUntil", {
                      time: formatTime(r.reservedUntil, locale),
                    })}
                  </Badge>
                ) : null}
              </div>
              <div className="min-w-24 text-end">
                {r.priceIlsMinor !== null && !r.priceOnRequest ? (
                  <Price
                    amountMinor={r.priceIlsMinor}
                    currency="ILS"
                    locale={locale}
                  />
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </div>
              <div className="flex gap-2">
                <Link
                  href={paths.admin.artwork(r.id)}
                  className={buttonClasses("secondary", "sm")}
                >
                  {t("list.edit")}
                </Link>
                {r.isPublished ? (
                  <Link
                    href={paths.artwork(r.slug)}
                    className={buttonClasses("ghost", "sm")}
                  >
                    {t("list.viewOnSite")}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav className="flex items-center gap-3">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })}>{tc("prev")}</Link>
          ) : null}
          <span>{tc("page", { page, pages })}</span>
          {page < pages ? (
            <Link href={href({ page: page + 1 })}>{tc("next")}</Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
