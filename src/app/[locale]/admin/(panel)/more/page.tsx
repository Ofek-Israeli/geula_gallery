import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SECONDARY } from "@/components/admin/AdminNav";
import { SignOutButton } from "@/components/admin/SignOutButton";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { requireAdmin } from "@/server/next/guards";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/more">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.more" });
  return { title: t("title") };
}

/** `/admin/more`: the mobile "עוד" tab (the secondary admin sections). */
export default async function MorePage({
  params,
}: PageProps<"/[locale]/admin/more">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const t = await getTranslations({ locale, namespace: "admin-shell" });
  return (
    <div className="flex max-w-md flex-col gap-6">
      <h1 className="text-3xl">{t("more.title")}</h1>
      <Link href="/admin/artworks/new" className={buttonClasses()}>
        {t("nav.newArtwork")}
      </Link>
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {SECONDARY.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="flex min-h-12 items-center no-underline"
            >
              {t(`nav.${item.key}`)}
            </Link>
          </li>
        ))}
        <li>
          <Link href="/" className="flex min-h-12 items-center no-underline">
            {t("nav.viewSite")}
          </Link>
        </li>
      </ul>
      <SignOutButton locale={locale} label={t("nav.signOut")} />
    </div>
  );
}
