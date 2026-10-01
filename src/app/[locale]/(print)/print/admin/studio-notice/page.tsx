import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { env } from "@/server/env";
import { requireAdmin } from "@/server/next/guards";
import { getSetting } from "@/server/settings";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * `/[locale]/print/admin/studio-notice` (spec §5.4 Printables, §5.10): the s.4C notice the painter
 * prints and displays for in-person sales at the studio (A4). Admin only. The seller identity
 * includes the business number (a printed notice is not a public legal page).
 */
export default async function StudioNoticePage({
  params,
}: PageProps<"/[locale]/print/admin/studio-notice">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const [t, profile] = await Promise.all([
    getTranslations({ locale, namespace: "documents-compliance.studioNotice" }),
    getSetting("business_profile"),
  ]);
  const cancelUrl = absoluteUrl(
    env.APP_URL,
    localePath(locale, paths.cancel()),
  );
  return (
    <article
      className="flex min-h-[250mm] flex-col gap-6 border-4 border-ink p-10 text-lg"
      data-testid="studio-notice"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-4xl">{t("title")}</h1>
        <p className="text-sm text-ink-muted">{t("subtitle")}</p>
      </header>
      <section>
        <h2 className="text-xl">{t("seller")}</h2>
        <p>
          {profile.legalName} · {profile.tradeName[locale]} ·{" "}
          <bdi dir="ltr">{profile.idNumber}</bdi>
        </p>
        <p>{profile.address[locale]}</p>
      </section>
      <p>
        {t("body1", {
          vat:
            profile.vatMode === "OSEK_PATUR" ? t("vatPatur") : t("vatMurshe"),
        })}
      </p>
      <p>{t("body2", { policy: t("policy") })}</p>
      <p>
        {t("body3")} <bdi dir="ltr">{cancelUrl}</bdi>
      </p>
      <p className="mbs-auto">
        {t.rich("contact", {
          phone: profile.phoneLocal,
          email: profile.email,
          ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
        })}
      </p>
      <p className="text-sm text-ink-muted print:hidden">{t("print")}</p>
    </article>
  );
}
