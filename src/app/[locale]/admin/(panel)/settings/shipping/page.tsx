import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/fulfillment/ActionForm";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ZONE_IDS } from "@/lib/countries";
import { formatDate, formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { env } from "@/server/env";
import { requireAdmin } from "@/server/next/guards";
import { getSetting } from "@/server/settings";
import { shippingSettingsToForm } from "@/server/shipping/settings-form";
import { saveShippingSettingsAction } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/settings/shipping">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "shipping.settings" });
  return { title: t("title") };
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 border border-line p-4">
      <legend className="px-1 text-lg">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * `/admin/settings/shipping` (spec §6.10): zones and estimates, the class-rate grid, piece fees,
 * time-boxed surcharges, insurance (with "coverage confirmed on"), value caps per carrier, the deny
 * and quote-only lists, thresholds, pickup, artist delivery, the domestic courier name, "Mark
 * calibrated today", the dated FX (read only; set in the checkout settings) and a read-only
 * providers panel (modes only, never secrets).
 */
export default async function ShippingSettingsPage({
  params,
}: PageProps<"/[locale]/admin/settings/shipping">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const [s, checkout] = await Promise.all([
    getSetting("shipping"),
    getSetting("checkout"),
  ]);
  const t = await getTranslations({ locale, namespace: "shipping.settings" });
  const f = shippingSettingsToForm(s);
  const val = (k: string) => {
    const v = f[k];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };
  const text = (id: string, name: string, label: string, ltr = false) => (
    <Field id={id} label={label}>
      {(c) => (
        <Input
          {...c}
          name={name}
          defaultValue={val(name)}
          {...(ltr ? { dir: "ltr" } : {})}
        />
      )}
    </Field>
  );
  const number = (id: string, name: string, label: string) => (
    <Field id={id} label={label}>
      {(c) => (
        <Input
          {...c}
          name={name}
          inputMode="decimal"
          dir="ltr"
          defaultValue={val(name)}
        />
      )}
    </Field>
  );
  const surchargeRows = s.surcharges.length + 1;

  return (
    <div
      className="flex max-w-5xl flex-col gap-6"
      data-testid="shipping-settings"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl">{t("title")}</h1>
        <p className="text-ink-muted">{t("intro")}</p>
        <p className="text-sm" data-testid="calibration">
          {s.calibratedAt
            ? t("calibratedAt", {
                date: formatDateTime(s.calibratedAt, locale),
              })
            : t("notCalibrated")}
        </p>
        <p className="text-sm">
          {t("fx", {
            usd: checkout.fx.ilsPerUsd,
            eur: checkout.fx.ilsPerEur,
            gbp: checkout.fx.ilsPerGbp,
            date: formatDate(checkout.fx.asOf, locale),
          })}
        </p>
      </header>

      <ActionForm
        action={saveShippingSettingsAction}
        locale={locale}
        submit={t("submit")}
        testId="shipping-settings-form"
      >
        <Group title={t("zones.title")}>
          {ZONE_IDS.map((z) => (
            <div
              key={z}
              className="grid gap-3 border-b border-line pbe-3 md:grid-cols-2"
            >
              <Checkbox
                id={`z-${z}-on`}
                name={`zone.${z}.enabled`}
                defaultChecked={val(`zone.${z}.enabled`) === "on"}
                label={`${t(`zones.name.${z}`)} – ${t("zones.enabled")}`}
                className="md:col-span-2"
              />
              {text(`z-${z}-he`, `zone.${z}.estimateHe`, t("zones.estimateHe"))}
              {text(`z-${z}-en`, `zone.${z}.estimateEn`, t("zones.estimateEn"))}
              <div className="md:col-span-2">
                {text(
                  `z-${z}-c`,
                  `zone.${z}.countries`,
                  t("zones.countries"),
                  true,
                )}
              </div>
            </div>
          ))}
        </Group>

        <Group title={t("rates.title")}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-start">{t("rates.zone")}</th>
                <th className="text-start">{t("rates.S")}</th>
                <th className="text-start">{t("rates.M")}</th>
                <th className="text-start">{t("rates.L")}</th>
              </tr>
            </thead>
            <tbody>
              {ZONE_IDS.map((z) => (
                <tr key={z}>
                  <th scope="row" className="py-1 text-start font-normal">
                    {t(`zones.name.${z}`)}
                  </th>
                  {(["S", "M", "L"] as const).map((c) => (
                    <td key={c} className="py-1 pe-2">
                      <Input
                        aria-label={`${t(`zones.name.${z}`)} ${t(`rates.${c}`)}`}
                        name={`rate.${z}.${c}`}
                        inputMode="decimal"
                        dir="ltr"
                        defaultValue={val(`rate.${z}.${c}`)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-3 md:grid-cols-3">
            {number("st-oversize", "oversizeFeeIls", t("rates.oversize"))}
            {number(
              "st-nonconv",
              "nonConveyableFeeIls",
              t("rates.nonConveyable"),
            )}
            {number("st-divisor", "divisor", t("divisor"))}
          </div>
          <Checkbox
            id="st-calibrated"
            name="markCalibrated"
            label={t("markCalibrated")}
          />
        </Group>

        <Group title={t("surcharges.title")}>
          {Array.from({ length: surchargeRows }, (_, i) => {
            const isNew = i === s.surcharges.length;
            return (
              <fieldset
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional form fields
                key={i}
                className="grid gap-3 border-b border-line pbe-3 md:grid-cols-3"
              >
                {isNew ? (
                  <legend className="font-medium">{t("surcharges.new")}</legend>
                ) : null}
                {text(`su-${i}-id`, `sur.${i}.id`, t("surcharges.id"), true)}
                {text(
                  `su-${i}-he`,
                  `sur.${i}.labelHe`,
                  t("surcharges.labelHe"),
                )}
                {text(
                  `su-${i}-en`,
                  `sur.${i}.labelEn`,
                  t("surcharges.labelEn"),
                )}
                <Field id={`su-${i}-kind`} label={t("surcharges.kind")}>
                  {(c) => (
                    <Select
                      {...c}
                      name={`sur.${i}.kind`}
                      defaultValue={val(`sur.${i}.kind`) || "PCT"}
                      options={[
                        { value: "PCT", label: t("surcharges.kindPct") },
                        { value: "FIXED", label: t("surcharges.kindFixed") },
                      ]}
                    />
                  )}
                </Field>
                {number(
                  `su-${i}-value`,
                  `sur.${i}.value`,
                  t("surcharges.value"),
                )}
                {text(
                  `su-${i}-zones`,
                  `sur.${i}.zones`,
                  t("surcharges.zones"),
                  true,
                )}
                <Field id={`su-${i}-from`} label={t("surcharges.startsOn")}>
                  {(c) => (
                    <Input
                      {...c}
                      type="date"
                      dir="ltr"
                      name={`sur.${i}.startsOn`}
                      defaultValue={val(`sur.${i}.startsOn`)}
                    />
                  )}
                </Field>
                <Field id={`su-${i}-to`} label={t("surcharges.endsOn")}>
                  {(c) => (
                    <Input
                      {...c}
                      type="date"
                      dir="ltr"
                      name={`sur.${i}.endsOn`}
                      defaultValue={val(`sur.${i}.endsOn`)}
                    />
                  )}
                </Field>
                <div className="flex flex-col gap-2">
                  <Checkbox
                    id={`su-${i}-on`}
                    name={`sur.${i}.enabled`}
                    defaultChecked={val(`sur.${i}.enabled`) === "on"}
                    label={t("surcharges.enabled")}
                  />
                  {isNew ? null : (
                    <Checkbox
                      id={`su-${i}-rm`}
                      name={`sur.${i}.remove`}
                      label={t("surcharges.remove")}
                    />
                  )}
                </div>
              </fieldset>
            );
          })}
        </Group>

        <Group title={t("insurance.title")}>
          <p className="text-sm" data-testid="coverage">
            {s.insurance.coverageConfirmedAt
              ? t("insurance.confirmedAt", {
                  date: formatDate(s.insurance.coverageConfirmedAt, locale),
                })
              : t("insurance.notConfirmed")}
          </p>
          <Checkbox
            id="in-on"
            name="ins.enabled"
            defaultChecked={s.insurance.enabled}
            label={t("insurance.enabled")}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <Field id="in-provider" label={t("insurance.provider")}>
              {(c) => (
                <Select
                  {...c}
                  name="ins.provider"
                  defaultValue={s.insurance.provider}
                  options={(["DHL", "THIRD_PARTY", "NONE"] as const).map(
                    (p) => ({
                      value: p,
                      label: t(`insurance.providerName.${p}`),
                    }),
                  )}
                />
              )}
            </Field>
            {number("in-rate", "ins.ratePct", t("insurance.ratePct"))}
            {number("in-min", "ins.minIls", t("insurance.minIls"))}
            {number(
              "in-max",
              "ins.maxInsuredIls",
              t("insurance.maxInsuredIls"),
            )}
          </div>
          <Checkbox
            id="in-confirm"
            name="ins.confirmToday"
            label={t("insurance.confirmToday")}
          />
        </Group>

        <Group title={t("caps.title")}>
          <div className="grid gap-3 md:grid-cols-3">
            {(["DHL", "MOCK", "MANUAL"] as const).map((c) => (
              <Field
                key={c}
                id={`cap-${c}`}
                label={t(`caps.carrier.${c}`)}
                hint={t("caps.none")}
              >
                {(p) => (
                  <Input
                    {...p}
                    name={`cap.${c}`}
                    inputMode="decimal"
                    dir="ltr"
                    defaultValue={val(`cap.${c}`)}
                  />
                )}
              </Field>
            ))}
          </div>
        </Group>

        <Group title={t("lists.title")}>
          <Field
            id="li-denied"
            label={t("lists.denied")}
            hint={t("lists.deniedHint")}
          >
            {(c) => (
              <Input
                {...c}
                name="deniedCountries"
                dir="ltr"
                defaultValue={val("deniedCountries")}
              />
            )}
          </Field>
          {text("li-quote", "quoteOnlyCountries", t("lists.quoteOnly"), true)}
        </Group>

        <Group title={t("thresholds.title")}>
          <div className="grid gap-3 md:grid-cols-2">
            {number("th-gb", "th.gbLowValueGbp", t("thresholds.gbLowValueGbp"))}
            {number("th-eu", "th.euLowValueEur", t("thresholds.euLowValueEur"))}
            {number(
              "th-us",
              "th.usFormalEntryUsd",
              t("thresholds.usFormalEntryUsd"),
            )}
            {number(
              "th-exp",
              "th.exportDeclarationUsd",
              t("thresholds.exportDeclarationUsd"),
            )}
          </div>
        </Group>

        <Group title={t("pickup.title")}>
          <Checkbox
            id="pu-on"
            name="pickup.enabled"
            defaultChecked={s.localPickup.enabled}
            label={t("pickup.enabled")}
          />
          {number("pu-fee", "pickup.feeIls", t("pickup.fee"))}
        </Group>

        <Group title={t("artist.title")}>
          <Checkbox
            id="ad-on"
            name="artist.enabled"
            defaultChecked={s.artistDelivery.enabled}
            label={t("artist.enabled")}
          />
          <div className="grid gap-3 md:grid-cols-3">
            {number("ad-fee", "artist.feeIls", t("artist.fee"))}
            {text("ad-he", "artist.areaHe", t("artist.areaHe"))}
            {text("ad-en", "artist.areaEn", t("artist.areaEn"))}
          </div>
        </Group>

        <Group title={t("domestic.title")}>
          <div className="grid gap-3 md:grid-cols-2">
            {text("dc-he", "domestic.he", t("domestic.nameHe"))}
            {text("dc-en", "domestic.en", t("domestic.nameEn"))}
          </div>
        </Group>
      </ActionForm>

      <section
        className="flex flex-col gap-1 border border-line p-4 text-sm"
        data-testid="providers-panel"
      >
        <h2 className="text-lg">{t("providers.title")}</h2>
        <p>{t("providers.carrier", { carrier: env.SHIPPING_CARRIER })}</p>
        <p>{t("providers.dhl", { mode: env.DHL_EXPRESS_MODE })}</p>
        <p>
          {t("providers.paperless", {
            value: env.DHL_PAPERLESS_TRADE
              ? t("providers.on")
              : t("providers.off"),
          })}
        </p>
      </section>
    </div>
  );
}
