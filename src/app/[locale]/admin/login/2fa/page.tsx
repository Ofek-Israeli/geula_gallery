import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";
import { getAdminSession, safeAdminNext } from "@/server/next/guards";
import { TwoFactorForm } from "./TwoFactorForm";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/login/2fa">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({
    locale,
    namespace: "admin-shell.twoFactor",
  });
  return { title: t("title") };
}

/**
 * Second step of sign-in for enrolled admins (spec §6.10). Better Auth holds the pending sign-in
 * in its short-lived two-factor cookie; there is no session yet, so no `requireAdmin` here.
 */
export default async function TwoFactorPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/login/2fa">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const next = safeAdminNext(
    locale,
    typeof sp.next === "string" ? sp.next : null,
  );
  if (await getAdminSession()) redirect(next);

  const t = await getTranslations({
    locale,
    namespace: "admin-shell.twoFactor",
  });
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12"
    >
      <h1 className="text-3xl">{t("title")}</h1>
      <TwoFactorForm locale={locale} next={next} />
    </main>
  );
}
