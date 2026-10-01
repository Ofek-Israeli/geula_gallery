import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";
import { env } from "@/server/env";
import { requireAdmin } from "@/server/next/guards";
import { EnrollForm } from "../../enroll-2fa/EnrollForm";
import { ChangePasswordForm, TwoFactorManage } from "./AccountForms";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/account">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.account" });
  return { title: t("title") };
}

/** `/admin/account` (spec §6.10): password; enrol or disable TOTP; backup codes. */
export default async function AccountPage({
  params,
}: PageProps<"/[locale]/admin/account">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const t = await getTranslations({ locale, namespace: "admin-shell.account" });
  return (
    <div className="flex max-w-xl flex-col gap-8">
      <h1 className="text-3xl">{t("title")}</h1>
      <p className="text-ink-muted">
        {t("signedInAs", { email: "" })}
        <bdi dir="ltr">{ctx.email}</bdi>
      </p>
      <section className="flex flex-col gap-3 border border-line p-4">
        <h2 className="text-xl">{t("password")}</h2>
        <ChangePasswordForm />
      </section>
      <section
        className="flex flex-col gap-3 border border-line p-4"
        data-testid="two-factor"
      >
        <h2 className="text-xl">{t("twoFactor")}</h2>
        <p>{ctx.twoFactorEnabled ? t("twoFactorOn") : t("twoFactorOff")}</p>
        {ctx.twoFactorEnabled ? (
          <TwoFactorManage canDisable={!env.ADMIN_REQUIRE_2FA} />
        ) : (
          <EnrollForm locale={locale} />
        )}
      </section>
    </div>
  );
}
