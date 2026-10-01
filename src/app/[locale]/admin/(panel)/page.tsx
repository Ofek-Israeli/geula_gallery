import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { isLocale } from "@/lib/locale";
import { countOpenAlerts } from "@/server/alerts/service";
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

/**
 * Dashboard placeholder (M1). WS4 builds the needs-attention cards, deadlines, turnover and the
 * go-live checklist (spec §6.10).
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
  const open = await countOpenAlerts(ctx);
  const total = open.INFO + open.WARNING + open.CRITICAL;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl">{t("title")}</h1>
      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <h2 id="attention" className="text-xl">
          {t("needsAttention")}
        </h2>
        <p>
          <Badge tone={open.CRITICAL > 0 ? "danger" : "neutral"}>
            {t("openAlerts", { count: total })}
          </Badge>
        </p>
        <p className="text-ink-muted">{t("placeholder")}</p>
      </section>
    </div>
  );
}
