import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionForm, FormCheckbox, FormField } from "@/components/admin/forms";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { activeSale } from "@/lib/sale";
import { providersPanel } from "@/server/admin/settings";
import { requireAdmin } from "@/server/next/guards";
import { getSetting } from "@/server/settings";
import { saveCheckoutAction, saveSaleAction } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/settings/checkout">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({
    locale,
    namespace: "admin-settings.checkout",
  });
  return { title: t("title") };
}

const NUMBERS = [
  "reservationMinutes",
  "linkHoursDefault",
  "maxActiveHoldsPerEmail",
  "maxActiveHoldsPerIp",
  "maxHoldsPerArtworkPerBuyer24h",
  "holdCooldownMinutes",
  "maxHoldCountPerOrder",
  "maxWebHoldSpanMinutes",
  "maxAttemptsPerOrder",
  "maxCartItems",
] as const;

/** `/admin/settings/checkout` (spec §4.7, §6.10): holds and limits, payments, FX, read-only Providers panel. */
export default async function CheckoutSettingsPage({
  params,
}: PageProps<"/[locale]/admin/settings/checkout">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const t = await getTranslations({ locale, namespace: "admin-settings" });
  const s = await getSetting("checkout");
  const running = activeSale(s.sale);
  const panel = providersPanel();
  const cfg = (ok: boolean) =>
    ok
      ? t("checkout.provider.configured")
      : t("checkout.provider.notConfigured");
  const rows: [string, string][] = [
    [
      t("checkout.provider.paymentProviders"),
      panel.paymentProviders.join(", "),
    ],
    [
      t("checkout.provider.cardcom"),
      `${panel.cardcom.mode} · ${cfg(panel.cardcom.configured)}`,
    ],
    [
      t("checkout.provider.paypal"),
      `${panel.paypal.mode} · ${cfg(panel.paypal.configured)}`,
    ],
    [t("checkout.provider.taxDocuments"), panel.taxDocuments.mode],
    [
      t("checkout.provider.morning"),
      `${panel.morning.mode} · ${cfg(panel.morning.configured)}`,
    ],
    [t("checkout.provider.shipping"), panel.shipping.carrier],
    [
      t("checkout.provider.dhl"),
      `${panel.dhl.mode} · ${cfg(panel.dhl.configured)}`,
    ],
    [
      t("checkout.provider.email"),
      `${panel.email.driver} · ${cfg(panel.email.configured)}`,
    ],
    [t("checkout.provider.storage"), panel.storage.driver],
    [t("checkout.provider.demo"), panel.demo ? "✓" : "—"],
    [t("checkout.provider.twoFactor"), panel.twoFactorRequired ? "✓" : "—"],
  ];
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href={paths.admin.settings()} className="text-sm">
        {t("index.title")}
      </Link>
      <h1 className="text-3xl">{t("checkout.title")}</h1>
      <p className="text-sm text-ink-muted">{t("freshHint")}</p>
      <section
        className="flex flex-col gap-3 border border-line p-4"
        data-testid="sale-settings"
      >
        <h2 className="text-xl">{t("checkout.sale.title")}</h2>
        <p className="text-sm text-ink-muted">{t("checkout.sale.hint")}</p>
        <p className="text-sm font-medium" data-testid="sale-status">
          {running
            ? t("checkout.sale.running", { percent: running.percentOff })
            : t("checkout.sale.notRunning")}
        </p>
        <ActionForm
          action={saveSaleAction}
          locale={locale}
          submitLabel={t("checkout.sale.save")}
          successText={t("saved")}
          errorNamespace="admin-settings.checkout.saleErrors"
          testId="sale-settings-form"
        >
          <FormCheckbox
            name="saleEnabled"
            label={t("checkout.sale.enabled")}
            defaultChecked={s.sale.enabled}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              name="salePercentOff"
              label={t("checkout.sale.percentOff")}
              type="number"
              inputMode="numeric"
              defaultValue={s.sale.percentOff}
            />
            <FormField
              name="saleStartsOn"
              label={t("checkout.sale.startsOn")}
              type="date"
              defaultValue={s.sale.startsOn ?? ""}
            />
            <FormField
              name="saleEndsOn"
              label={t("checkout.sale.endsOn")}
              type="date"
              defaultValue={s.sale.endsOn ?? ""}
            />
          </div>
          <p className="text-sm text-ink-muted">
            {t("checkout.sale.datesHint")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="saleLabelHe"
              label={t("checkout.sale.labelHe")}
              defaultValue={s.sale.label.he}
              dir="rtl"
            />
            <FormField
              name="saleLabelEn"
              label={t("checkout.sale.labelEn")}
              defaultValue={s.sale.label.en}
              dir="ltr"
            />
          </div>
        </ActionForm>
      </section>
      <ActionForm
        action={saveCheckoutAction}
        locale={locale}
        submitLabel={t("save")}
        successText={t("saved")}
        testId="checkout-settings-form"
      >
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="font-sans text-lg font-semibold">
            {t("checkout.holds")}
          </legend>
          {NUMBERS.map((n) => (
            <FormField
              key={n}
              name={n}
              label={t(`checkout.${n}`)}
              type="number"
              inputMode="numeric"
              defaultValue={s[n]}
              required
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="font-sans text-lg font-semibold">
            {t("checkout.payments")}
          </legend>
          <FormField
            name="maxInstallments"
            label={t("checkout.maxInstallments")}
            type="number"
            inputMode="numeric"
            defaultValue={s.maxInstallments}
          />
          <FormCheckbox
            name="paypalForIsraeliDestinations"
            label={t("checkout.paypalForIsraeliDestinations")}
            defaultChecked={s.paypalForIsraeliDestinations}
          />
          <FormCheckbox
            name="receiptForRefundedPayments"
            label={t("checkout.receiptForRefundedPayments")}
            defaultChecked={s.receiptForRefundedPayments}
          />
          <FormField
            name="conversationLookbackDays"
            label={t("checkout.conversationLookbackDays")}
            type="number"
            inputMode="numeric"
            defaultValue={s.conversationLookbackDays}
          />
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="font-sans text-lg font-semibold">
            {t("checkout.fx")}
          </legend>
          <FormField
            name="ilsPerUsd"
            label={t("checkout.ilsPerUsd")}
            type="number"
            defaultValue={s.fx.ilsPerUsd}
          />
          <FormField
            name="ilsPerEur"
            label={t("checkout.ilsPerEur")}
            type="number"
            defaultValue={s.fx.ilsPerEur}
          />
          <FormField
            name="ilsPerGbp"
            label={t("checkout.ilsPerGbp")}
            type="number"
            defaultValue={s.fx.ilsPerGbp}
          />
          <FormField
            name="fxAsOf"
            label={t("checkout.asOf")}
            type="date"
            defaultValue={s.fx.asOf}
          />
        </fieldset>
      </ActionForm>
      <section
        className="flex flex-col gap-2 border border-line p-4"
        data-testid="providers-panel"
      >
        <h2 className="text-xl">{t("checkout.providers")}</h2>
        <p className="text-sm text-ink-muted">{t("checkout.providersHint")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-muted">{k}</dt>
              <dd>
                <bdi dir="ltr">{v}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
