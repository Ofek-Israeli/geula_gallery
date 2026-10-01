import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { type AttentionCard, getDashboard } from "@/server/admin/dashboard";
import { requireAdmin } from "@/server/next/guards";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({
    locale,
    namespace: "admin-shell.dashboard",
  });
  return { title: t("title") };
}

const CARD_LINK: Partial<Record<AttentionCard["key"], string>> = {
  cancellationRefunds: paths.admin.cancellations(),
  openRequests: paths.admin.inbox(),
  ratesUncalibrated: paths.admin.settings("shipping"),
  criticalAlerts: paths.admin.alerts(),
  staleCron: paths.admin.alerts(),
};

/**
 * Dashboard (spec §6.10 `/admin`): needs-attention cards (refund deadlines, refunds and tax
 * documents that need the admin, deferred payments, unknown labels, orders to fulfil, blocks,
 * open requests, uncalibrated rates, stale cron, critical alerts), the year-to-date turnover
 * against the osek-patur ceiling and the go-live readiness list (`golive.ts` blockers first).
 */
export default async function AdminDashboardPage({
  params,
}: PageProps<"/[locale]/admin">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const t = await getTranslations({
    locale,
    namespace: "admin-shell.dashboard",
  });
  const data = await getDashboard(ctx);
  const active = data.cards.filter((c) => c.count > 0);
  const { turnover } = data;
  const blockers = data.goLive.filter((g) => g.blocker && !g.ok).length;
  const pct =
    turnover.ceilingIlsMinor !== null && turnover.ceilingIlsMinor > 0
      ? Math.round((turnover.totalIlsMinor / turnover.ceilingIlsMinor) * 100)
      : null;
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl">{t("title")}</h1>
      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <h2 id="attention" className="text-xl">
          {t("needsAttention")}
        </h2>
        {active.length === 0 ? (
          <p data-testid="dashboard-all-clear">{t("allClear")}</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {active.map((c) => (
              <li
                key={c.key}
                className={
                  c.severity === "critical"
                    ? "flex flex-col gap-2 border-2 border-reddot p-4"
                    : "flex flex-col gap-2 border border-line p-4"
                }
                data-testid={`attention-${c.key}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-sans font-semibold">
                    {t(`cards.${c.key}`)}
                  </h3>
                  <Badge
                    tone={c.severity === "critical" ? "danger" : "neutral"}
                  >
                    {c.count}
                  </Badge>
                </div>
                {c.items.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-sm">
                    {c.items.map((item) => (
                      <li key={`${item.orderId ?? ""}:${item.label}`}>
                        {item.cancellationId ? (
                          <Link
                            href={paths.admin.cancellation(item.cancellationId)}
                          >
                            <bdi dir="ltr">{item.label}</bdi>
                          </Link>
                        ) : item.orderId ? (
                          <Link href={paths.admin.order(item.orderId)}>
                            <bdi dir="ltr">{item.label}</bdi>
                          </Link>
                        ) : (
                          <bdi dir="ltr">{item.label}</bdi>
                        )}
                        {item.dueAt ? (
                          <span className="text-ink-muted">
                            {" · "}
                            {t("due", { date: formatDate(item.dueAt, locale) })}
                          </span>
                        ) : null}
                      </li>
                    ))}
                    {c.count > c.items.length ? (
                      <li className="text-ink-muted">
                        {t("more", { count: c.count - c.items.length })}
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                {CARD_LINK[c.key] ? (
                  <Link href={CARD_LINK[c.key] ?? "/admin"} className="text-sm">
                    {t(`links.${c.key}` as "links.openRequests")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="turnover"
        className="flex flex-col gap-2 border border-line p-4"
        data-testid="dashboard-turnover"
      >
        <h2 id="turnover" className="text-xl">
          {t("turnover.title", { year: turnover.year })}
        </h2>
        <p className="text-2xl">
          <Price
            amountMinor={turnover.totalIlsMinor}
            currency="ILS"
            locale={locale}
          />
        </p>
        {turnover.ceilingIlsMinor !== null ? (
          <>
            <p className="text-sm">
              {t("turnover.of", { ceiling: "" })}
              <Price
                amountMinor={turnover.ceilingIlsMinor}
                currency="ILS"
                locale={locale}
              />{" "}
              · <bdi dir="ltr">{pct}%</bdi>
            </p>
            <progress
              className="h-2 w-full max-w-md accent-ink"
              max={100}
              value={Math.min(100, pct ?? 0)}
              aria-label={t("turnover.title", { year: turnover.year })}
            />
          </>
        ) : (
          <p className="text-sm">{t("turnover.noCeiling")}</p>
        )}
        <p className="text-sm text-ink-muted">
          {t("turnover.count", { count: turnover.salesCount })} ·{" "}
          {t("turnover.hint")}
        </p>
      </section>

      <section
        aria-labelledby="golive"
        className="flex flex-col gap-2 border border-line p-4"
      >
        <h2 id="golive" className="text-xl">
          {t("goLive.title")}
        </h2>
        <p className="text-sm text-ink-muted">
          {blockers === 0
            ? t("goLive.noBlockers")
            : t("goLive.blockers", { count: blockers })}
        </p>
        <ul className="flex flex-col gap-1" data-testid="dashboard-golive">
          {data.goLive.map((g) => (
            <li
              key={g.key}
              className="flex items-center gap-2"
              data-key={g.key}
              data-ok={g.ok}
            >
              <span aria-hidden="true">{g.ok ? "✓" : "✗"}</span>
              <span>{t(`goLive.items.${g.key}`)}</span>
              <span className="text-sm text-ink-muted">
                ({g.ok ? t("goLive.ok") : t("goLive.missing")}
                {g.blocker ? "" : ` · ${t("goLive.optional")}`})
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
