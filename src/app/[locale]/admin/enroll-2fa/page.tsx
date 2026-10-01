import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";
import { requireAdmin } from "@/server/next/guards";
import { EnrollForm } from "./EnrollForm";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/enroll-2fa">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.enroll" });
  return { title: t("title") };
}

/**
 * Forced TOTP enrolment (spec §6.10). Lives OUTSIDE `(panel)` so `requireAdmin()` in the panel can
 * redirect here without a loop; this page uses `allowUnenrolled`.
 */
export default async function EnrollTwoFactorPage({
  params,
}: PageProps<"/[locale]/admin/enroll-2fa">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale, allowUnenrolled: true });
  if (ctx.twoFactorEnabled) redirect(`/${locale}/admin`);

  const t = await getTranslations({ locale, namespace: "admin-shell.enroll" });
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-12"
    >
      <h1 className="text-3xl">{t("title")}</h1>
      <p>{t("intro")}</p>
      <EnrollForm locale={locale} />
    </main>
  );
}
