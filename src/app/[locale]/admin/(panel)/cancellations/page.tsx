import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { formatDate, formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { listCancellations } from "@/server/cancellations/service";
import { requireAdmin } from "@/server/next/guards";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/cancellations">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "cancel.admin" });
  return { title: t("listTitle") };
}

/**
 * `/admin/cancellations` (spec §6.10): open notices first, sorted by the refund due date; masked
 * IDs; duplicate badges; overdue / due-soon markers.
 */
export default async function AdminCancellationsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/cancellations">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const all = (await searchParams).status === "all";
  const [t, ts, rows] = await Promise.all([
    getTranslations({ locale, namespace: "cancel.admin" }),
    getTranslations({ locale, namespace: "cancel.status" }),
    listCancellations(ctx, { status: all ? "ALL" : "OPEN" }),
  ]);
  const now = Date.now();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl">{t("listTitle")}</h1>
        <Link
          href={paths.admin.newCancellation()}
          className={buttonClasses("primary", "sm")}
        >
          {t("newNotice")}
        </Link>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label={t("colStatus")}>
        <Link
          href={paths.admin.cancellations()}
          aria-current={all ? undefined : "page"}
          className={buttonClasses(all ? "ghost" : "secondary", "sm")}
        >
          {t("filterOpen")}
        </Link>
        <Link
          href={`${paths.admin.cancellations()}?status=all`}
          aria-current={all ? "page" : undefined}
          className={buttonClasses(all ? "secondary" : "ghost", "sm")}
        >
          {t("filterAll")}
        </Link>
      </nav>
      {rows.length === 0 ? (
        <p className="text-ink-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full border-collapse text-sm"
            data-testid="cancellations-table"
          >
            <thead>
              <tr className="border-b border-line text-start">
                <th className="px-2 py-2 text-start">{t("colNumber")}</th>
                <th className="px-2 py-2 text-start">{t("colName")}</th>
                <th className="px-2 py-2 text-start">{t("colId")}</th>
                <th className="px-2 py-2 text-start">{t("colOrder")}</th>
                <th className="px-2 py-2 text-start">{t("colReceived")}</th>
                <th className="px-2 py-2 text-start">{t("colDue")}</th>
                <th className="px-2 py-2 text-start">{t("colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = r.status === "RECEIVED" || r.status === "ACCEPTED";
                const due =
                  r.refundDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
                const overdue = open && due < now;
                const soon = open && !overdue && due - now < 5 * 86_400_000;
                return (
                  <tr key={r.id} className="border-b border-line align-top">
                    <td className="px-2 py-2">
                      <Link
                        href={paths.admin.cancellation(r.id)}
                        className="underline"
                      >
                        <bdi dir="ltr">{r.number}</bdi>
                      </Link>
                      {r.possibleDuplicate ? (
                        <span className="ms-2">
                          <Badge>{t("duplicateBadge")}</Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{r.fullName}</td>
                    <td className="px-2 py-2">
                      {r.idNumberMasked ? (
                        <bdi dir="ltr">{r.idNumberMasked}</bdi>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {r.orderNumber ? (
                        <bdi dir="ltr">{r.orderNumber}</bdi>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {formatDateTime(r.receivedAt, locale)}
                    </td>
                    <td className="px-2 py-2">
                      {r.refundDueAt ? formatDate(r.refundDueAt, locale) : "—"}
                      {overdue ? (
                        <span className="ms-2 font-semibold text-reddot">
                          {t("overdue")}
                        </span>
                      ) : soon ? (
                        <span className="ms-2 font-semibold text-hold">
                          {t("dueSoon")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{ts(r.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
