import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";
import { getAdminSession, safeAdminNext } from "@/server/next/guards";
import { LoginForm } from "./LoginForm";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/login">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.login" });
  return { title: t("title") };
}

/**
 * Admin sign-in (spec §6.10). The only admin pages without `requireAdmin` are this one and
 * `login/2fa`. Sign-in runs in the browser through the Better Auth client so the
 * `/sign-in/email` database rate limit applies.
 */
export default async function AdminLoginPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/login">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const next = safeAdminNext(
    locale,
    typeof sp.next === "string" ? sp.next : null,
  );
  const reauth = sp.reauth === "1";
  if (!reauth && (await getAdminSession())) redirect(next);

  const t = await getTranslations({ locale, namespace: "admin-shell.login" });
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12"
    >
      <h1 className="text-3xl">{t("title")}</h1>
      {reauth ? (
        <p
          role="status"
          className="rounded-sm border border-hold p-3 text-hold"
        >
          {t("reauth")}
        </p>
      ) : null}
      <LoginForm locale={locale} next={next} />
    </main>
  );
}
