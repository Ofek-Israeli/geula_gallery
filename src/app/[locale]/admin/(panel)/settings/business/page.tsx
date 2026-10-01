import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionForm, FormCheckbox, FormField } from "@/components/admin/forms";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";
import { getSetting } from "@/server/settings";
import { saveBusinessAction } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/settings/business">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({
    locale,
    namespace: "admin-settings.business",
  });
  return { title: t("title") };
}

/** `/admin/settings/business` (spec §4.7, §6.10): business identity, VAT (with an explanation), contacts, pickup. */
export default async function BusinessSettingsPage({
  params,
}: PageProps<"/[locale]/admin/settings/business">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const t = await getTranslations({ locale, namespace: "admin-settings" });
  const p = await getSetting("business_profile");
  const pair = (
    name: string,
    label: string,
    he: string,
    en: string,
    textarea = false,
  ) => (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        name={`${name}He`}
        label={`${label} (${t("he")})`}
        defaultValue={he}
        type={textarea ? "textarea" : "text"}
        rows={3}
        dir="rtl"
      />
      <FormField
        name={`${name}En`}
        label={`${label} (${t("en")})`}
        defaultValue={en}
        type={textarea ? "textarea" : "text"}
        rows={3}
        dir="ltr"
      />
    </div>
  );
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href={paths.admin.settings()} className="text-sm">
        {t("index.title")}
      </Link>
      <h1 className="text-3xl">{t("business.title")}</h1>
      <p className="text-sm text-ink-muted">{t("freshHint")}</p>
      <ActionForm
        action={saveBusinessAction}
        locale={locale}
        submitLabel={t("save")}
        successText={t("saved")}
        testId="business-form"
      >
        <fieldset className="flex flex-col gap-4">
          <legend className="font-sans text-lg font-semibold">
            {t("business.identity")}
          </legend>
          <FormField
            name="legalName"
            label={t("business.legalName")}
            defaultValue={p.legalName}
            required
          />
          {pair(
            "tradeName",
            t("business.tradeName"),
            p.tradeName.he,
            p.tradeName.en,
          )}
          {pair(
            "artistName",
            t("business.artistName"),
            p.artistName.he,
            p.artistName.en,
          )}
          <FormField
            name="signatureName"
            label={t("business.signatureName")}
            defaultValue={p.signatureName}
            required
          />
          <FormField
            name="idNumber"
            label={t("business.idNumber")}
            hint={t("business.idNumberHint")}
            defaultValue={p.idNumber}
            dir="ltr"
            inputMode="numeric"
            required
          />
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="font-sans text-lg font-semibold">
            {t("business.vat")}
          </legend>
          <p className="text-sm">{t("business.vatExplain")}</p>
          <FormField
            name="vatMode"
            label={t("business.vatMode")}
            type="select"
            defaultValue={p.vatMode}
            options={(["OSEK_PATUR", "OSEK_MURSHE"] as const).map((m) => ({
              value: m,
              label: t(`business.vatModes.${m}`),
            }))}
          />
          <FormField
            name="vatNumber"
            label={t("business.vatNumber")}
            defaultValue={p.vatNumber}
            dir="ltr"
          />
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="font-sans text-lg font-semibold">
            {t("business.contact")}
          </legend>
          {pair(
            "address",
            t("business.address"),
            p.address.he,
            p.address.en,
            true,
          )}
          {pair(
            "returnAddress",
            t("business.returnAddress"),
            p.returnAddress.he,
            p.returnAddress.en,
            true,
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="phoneLocal"
              label={t("business.phoneLocal")}
              defaultValue={p.phoneLocal}
              type="tel"
              required
            />
            <FormField
              name="phoneIntl"
              label={t("business.phoneIntl")}
              defaultValue={p.phoneIntl}
              type="tel"
              required
            />
            <FormField
              name="email"
              label={t("business.email")}
              defaultValue={p.email}
              type="email"
              required
            />
            <FormField
              name="notificationEmail"
              label={t("business.notificationEmail")}
              defaultValue={p.notificationEmail}
              type="email"
              required
            />
          </div>
          <FormField
            name="accessibilityContact"
            label={t("business.accessibilityContact")}
            defaultValue={p.accessibilityContact}
            required
          />
          <FormField
            name="privacyContact"
            label={t("business.privacyContact")}
            defaultValue={p.privacyContact}
            required
          />
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="font-sans text-lg font-semibold">
            {t("business.pickup")}
          </legend>
          {pair(
            "pickupAddress",
            t("business.pickupAddress"),
            p.pickupAddress.he,
            p.pickupAddress.en,
            true,
          )}
          {pair(
            "pickupInstructions",
            t("business.pickupInstructions"),
            p.pickupInstructions.he,
            p.pickupInstructions.en,
            true,
          )}
        </fieldset>
        <FormCheckbox
          name="completed"
          label={t("business.completed")}
          defaultChecked={p.completed}
        />
      </ActionForm>
    </div>
  );
}
