import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import type { OrderStatus } from "@/server/domain/state-machines";
import { requireAdmin } from "@/server/next/guards";
import { ADMIN_ORDERS_PAGE_SIZE, listAdminOrders } from "@/server/orders/admin";

const STATUSES = [
  "AWAITING_PAYMENT",
  "PAYMENT_REVIEW",
  "PAID",
  "EXPIRED",
  "CANCELLED",
  "COMPLETED",
] as const satisfies readonly OrderStatus[];

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/orders">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-orders.list" });
  return { title: t("title") };
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * `/admin/orders` (spec §6.10): newest first, filter by status, search by number / buyer name /
 * email. M2 version; WS4 adds badges, deadlines and the manual order button.
 */
export default async function AdminOrdersPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/orders">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const sp = await searchParams;
  const statusParam = one(sp.status);
  const status = STATUSES.find((s) => s === statusParam);
  const q = one(sp.q)?.slice(0, 80) ?? "";
  const page = Number.parseInt(one(sp.page) ?? "1", 10) || 1;
  const t = await getTranslations({ locale, namespace: "admin-orders" });
  const { rows, total } = await listAdminOrders(ctx, { status, q, page });
  const pages = Math.max(1, Math.ceil(total / ADMIN_ORDERS_PAGE_SIZE));
  const query = (extra: Record<string, string | number | undefined>) =>
    paths.admin.orders({ status, q: q || undefined, ...extra });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl">{t("list.title")}</h1>
      <nav aria-label={t("list.status")} className="flex flex-wrap gap-2">
        <Link
          href={paths.admin.orders({ q: q || undefined })}
          aria-current={status ? undefined : "page"}
          className={buttonClasses(status ? "ghost" : "secondary", "sm")}
        >
          {t("list.all")}
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={paths.admin.orders({ status: s, q: q || undefined })}
            aria-current={status === s ? "page" : undefined}
            className={buttonClasses(
              status === s ? "secondary" : "ghost",
              "sm",
            )}
          >
            {t(`status.${s}`)}
          </Link>
        ))}
      </nav>
      <form method="get" className="flex flex-wrap items-end gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <label htmlFor="orders-q" className="sr-only">
          {t("list.searchLabel")}
        </label>
        <Input
          id="orders-q"
          name="q"
          defaultValue={q}
          placeholder={t("list.searchLabel")}
          className="max-w-sm"
        />
        <button type="submit" className={buttonClasses("secondary")}>
          {t("list.search")}
        </button>
      </form>
      <p className="text-sm text-ink-muted">
        {t("list.count", { count: total })}
      </p>
      {rows.length === 0 ? (
        <p>{t("list.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[40rem] border-collapse text-sm"
            data-testid="orders-table"
          >
            <thead>
              <tr className="border-b border-line">
                <th className="py-2 text-start font-semibold">
                  {t("list.number")}
                </th>
                <th className="py-2 text-start font-semibold">
                  {t("list.date")}
                </th>
                <th className="py-2 text-start font-semibold">
                  {t("list.work")}
                </th>
                <th className="py-2 text-start font-semibold">
                  {t("list.buyer")}
                </th>
                <th className="py-2 text-end font-semibold">
                  {t("list.total")}
                </th>
                <th className="py-2 text-start font-semibold">
                  {t("list.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line">
                  <td className="py-2">
                    <Link href={paths.admin.order(r.id)}>
                      <bdi>{r.number}</bdi>
                    </Link>
                    {r.isDemo ? (
                      <Badge className="ms-2">{t("list.demo")}</Badge>
                    ) : null}
                  </td>
                  <td className="py-2">
                    {formatDate(r.createdAt, locale, "short")}
                  </td>
                  <td className="py-2">
                    {(locale === "he" ? r.titleHe : r.titleEn) ?? "—"}
                  </td>
                  <td className="py-2">
                    <bdi>{r.buyerName ?? "—"}</bdi>
                  </td>
                  <td className="py-2 text-end">
                    <Price
                      amountMinor={r.totalMinor}
                      currency={r.currency}
                      locale={locale}
                    />
                  </td>
                  <td className="py-2">
                    <Badge
                      tone={
                        r.status === "PAID" || r.status === "COMPLETED"
                          ? "sold"
                          : r.status === "PAYMENT_REVIEW"
                            ? "hold"
                            : "neutral"
                      }
                    >
                      {t(`status.${r.status}`)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <nav className="flex gap-3" aria-label={t("list.title")}>
          {page > 1 ? (
            <Link
              href={query({ page: page - 1 })}
              className={buttonClasses("ghost", "sm")}
            >
              {t("list.prev")}
            </Link>
          ) : null}
          {page < pages ? (
            <Link
              href={query({ page: page + 1 })}
              className={buttonClasses("ghost", "sm")}
            >
              {t("list.next")}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
