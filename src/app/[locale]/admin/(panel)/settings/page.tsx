import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/settings">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({
    locale,
    namespace: "admin-settings.index",
  });
  return { title: t("title") };
}

const SECTIONS = ["business", "checkout", "shipping", "cancellation"] as const;

/** `/admin/settings`: the four settings sections (spec §6.10). */
export default async function SettingsIndexPage({
  params,
}: PageProps<"/[locale]/admin/settings">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const t = await getTranslations({
    locale,
    namespace: "admin-settings.index",
  });
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-3xl">{t("title")}</h1>
      <ul className="grid gap-3 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <li key={s} className="flex flex-col gap-1 border border-line p-4">
            <Link href={paths.admin.settings(s)} className="font-medium">
              {t(s)}
            </Link>
            <p className="text-sm text-ink-muted">{t(`${s}Hint`)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
