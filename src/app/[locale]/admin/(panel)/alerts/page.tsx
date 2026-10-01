import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/admin/forms";
import { Badge } from "@/components/ui/Badge";
import { Link } from "@/i18n/navigation";
import { formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { getAlertsPage } from "@/server/admin/alerts";
import { requireAdmin } from "@/server/next/guards";
import { acknowledgeAction, retryDeadJobAction } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/alerts">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.alerts" });
  return { title: t("title") };
}

/** `/admin/alerts` (spec §6.10): acknowledge alerts; retry DEAD outbox jobs. */
export default async function AlertsPage({
  params,
}: PageProps<"/[locale]/admin/alerts">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const t = await getTranslations({ locale, namespace: "admin-shell.alerts" });
  const { alerts, dead } = await getAlertsPage(ctx);
  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <h1 className="text-3xl">{t("title")}</h1>
      <section aria-labelledby="open-alerts" className="flex flex-col gap-3">
        <h2 id="open-alerts" className="text-xl">
          {t("open")}
        </h2>
        {alerts.length === 0 ? (
          <p>{t("none")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 py-3"
                data-testid="alert-row"
              >
                <Badge
                  tone={
                    a.severity === "CRITICAL"
                      ? "danger"
                      : a.severity === "WARNING"
                        ? "hold"
                        : "neutral"
                  }
                >
                  {t(`severity.${a.severity}`)}
                </Badge>
                <bdi dir="ltr" className="font-medium">
                  {a.kind}
                </bdi>
                <span className="text-sm text-ink-muted">
                  {formatDateTime(a.createdAt, locale)}
                </span>
                {a.entity === "order" && a.entityId ? (
                  <Link
                    href={paths.admin.order(a.entityId)}
                    className="text-sm"
                  >
                    {t("openOrder")}
                  </Link>
                ) : a.entity ? (
                  <span className="text-sm text-ink-muted">
                    <bdi dir="ltr">
                      {t("entity", { entity: a.entity, id: a.entityId ?? "" })}
                    </bdi>
                  </span>
                ) : null}
                <div className="ms-auto">
                  <ActionForm
                    action={acknowledgeAction}
                    locale={locale}
                    hidden={{ alertId: a.id }}
                    submitLabel={t("acknowledge")}
                    submitVariant="secondary"
                    submitSize="sm"
                    successText={t("acknowledged")}
                    inline
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="dead-jobs" className="flex flex-col gap-3">
        <h2 id="dead-jobs" className="text-xl">
          {t("dead")}
        </h2>
        <p className="text-sm text-ink-muted">{t("deadHint")}</p>
        {dead.length === 0 ? (
          <p>{t("deadNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {dead.map((j) => (
              <li
                key={j.id}
                className="flex flex-col gap-1 py-3"
                data-testid="dead-job"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <bdi dir="ltr" className="font-medium">
                    {j.kind}
                  </bdi>
                  <bdi dir="ltr" className="text-sm text-ink-muted">
                    {j.dedupeKey}
                  </bdi>
                  <span className="text-sm text-ink-muted">
                    {t("attempts", { count: j.attempts })} ·{" "}
                    {formatDateTime(j.updatedAt, locale)}
                  </span>
                </div>
                {j.lastError ? (
                  <p className="text-sm text-reddot">
                    <bdi dir="ltr">
                      {t("lastError", { error: j.lastError.slice(0, 300) })}
                    </bdi>
                  </p>
                ) : null}
                <ActionForm
                  action={retryDeadJobAction}
                  locale={locale}
                  hidden={{ jobId: String(j.id) }}
                  submitLabel={t("retry")}
                  submitVariant="secondary"
                  submitSize="sm"
                  successText={t("retried")}
                  inline
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
