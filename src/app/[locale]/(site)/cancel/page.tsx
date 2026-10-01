import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PrivacyNotice } from "@/components/ui/PrivacyNotice";
import { LEGAL_TEXTS_APPROVED } from "@/content/legal/versions";
import { isLocale } from "@/lib/locale";
import { parseOrderNumber } from "@/lib/validation/identifiers";
import { issueFormStartToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { cancelFlowAction } from "./actions";
import { CancelFlow } from "./CancelFlow";

/**
 * `/[locale]/cancel` (spec §5.7 steps 2–4, §6.2): the rights, every channel (phone local and +972,
 * email, registered mail, the online form) and the single POST form → review → acknowledgement.
 * noindex. `?order=` only prefills the order number (never PII). The seller ID number is not shown.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/cancel">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "cancel.meta" });
  return {
    title: t("title"),
    description: t("description"),
    robots: { index: false, follow: false },
  };
}

export default async function CancelPage({
  params,
  searchParams,
}: PageProps<"/[locale]/cancel">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const order = (await searchParams).order;
  const prefill =
    typeof order === "string"
      ? (parseOrderNumber(order) ?? undefined)
      : undefined;
  const [t, profile] = await Promise.all([
    getTranslations({ locale, namespace: "cancel.page" }),
    getSetting("business_profile"),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl">{t("title")}</h1>
        {LEGAL_TEXTS_APPROVED ? null : (
          <p className="w-fit rounded-sm border border-hold px-2 py-1 text-sm text-hold">
            {t("draft")}
          </p>
        )}
        <p className="max-w-prose">{t("intro")}</p>
      </header>

      <section aria-labelledby="rights-title" className="flex flex-col gap-2">
        <h2 id="rights-title" className="text-2xl">
          {t("rightsTitle")}
        </h2>
        <ul className="flex max-w-prose list-disc flex-col gap-2 ps-5">
          <li>{t("rights14")}</li>
          <li>{t("rights4m")}</li>
          <li>{t("rightsFee")}</li>
          <li>{t("rightsRefund")}</li>
        </ul>
      </section>

      <section aria-labelledby="channels-title" className="flex flex-col gap-2">
        <h2 id="channels-title" className="text-2xl">
          {t("channelsTitle")}
        </h2>
        <ul className="flex flex-col gap-1" data-testid="cancel-channels">
          <li>
            <a href="#cancel-form-title" className="underline">
              {t("channelForm")}
            </a>
          </li>
          <li>
            {t.rich("channelPhone", {
              phone: profile.phoneLocal,
              phoneIntl: profile.phoneIntl,
              ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })}
          </li>
          <li>
            {t.rich("channelEmail", {
              email: profile.email,
              ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })}
          </li>
          <li>{t("channelMail", { address: profile.address[locale] })}</li>
        </ul>
      </section>

      <section
        aria-labelledby="cancel-form-title"
        className="flex flex-col gap-4"
      >
        <h2 id="cancel-form-title" className="text-2xl">
          {t("formTitle")}
        </h2>
        <p className="max-w-prose">{t("formIntro")}</p>
        <CancelFlow
          action={cancelFlowAction}
          locale={locale}
          formStart={issueFormStartToken()}
          prefillOrder={prefill}
        />
        <PrivacyNotice>{t("privacy")}</PrivacyNotice>
      </section>
    </div>
  );
}
