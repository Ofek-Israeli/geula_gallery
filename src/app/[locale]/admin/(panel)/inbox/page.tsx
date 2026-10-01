import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths, withQuery } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";
import { type InboxFilter, listRequests } from "@/server/requests/service";

const FILTERS = [
  "open",
  "quotes",
  "questions",
  "all",
] as const satisfies readonly InboxFilter[];

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/inbox">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.inbox" });
  return { title: t("title") };
}

/** `/admin/inbox` (spec §6.10): questions and quote requests, newest first; open ones by default. */
export default async function InboxPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/inbox">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const sp = await searchParams;
  const raw = Array.isArray(sp.filter) ? sp.filter[0] : sp.filter;
  const filter = FILTERS.find((f) => f === raw) ?? "open";
  const t = await getTranslations({ locale, namespace: "admin-shell.inbox" });
  const { rows, total } = await listRequests(ctx, { filter });
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl">{t("title")}</h1>
      <nav aria-label={t("filters")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={withQuery(paths.admin.inbox(), {
              filter: f === "open" ? undefined : f,
            })}
            aria-current={filter === f ? "page" : undefined}
            className={buttonClasses(
              filter === f ? "secondary" : "ghost",
              "sm",
            )}
          >
            {t(`filter.${f}`)}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-ink-muted">{t("count", { count: total })}</p>
      {rows.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-1 py-3"
              data-testid="inbox-row"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Link href={paths.admin.request(r.id)} className="font-medium">
                  <bdi>{r.name}</bdi>
                </Link>
                <Badge>{t(`kind.${r.kind}`)}</Badge>
                <Badge tone={r.status === "NEW" ? "hold" : "neutral"}>
                  {t(`status.${r.status}`)}
                </Badge>
                <span className="text-sm text-ink-muted">
                  {formatDateTime(r.createdAt, locale)}
                </span>
              </div>
              <p className="text-sm text-ink-muted">
                {(locale === "he" ? r.artworkTitleHe : r.artworkTitleEn) ??
                  t("noArtwork")}
                {r.country ? ` · ${r.country}` : ""}
              </p>
              {r.message ? (
                <p className="line-clamp-2 text-sm">
                  <bdi>{r.message}</bdi>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
