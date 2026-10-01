import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionForm, FormCheckbox, FormField } from "@/components/admin/forms";
import { Link } from "@/i18n/navigation";
import { countryOptions } from "@/lib/countries";
import { isLocale } from "@/lib/locale";
import { toDecimalString } from "@/lib/money";
import { paths } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";
import { listSellableArtworks } from "@/server/orders/admin";
import { getSetting } from "@/server/settings";
import { createManualOrderAction } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/orders/new">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-orders.new" });
  return { title: t("title") };
}

/**
 * `/admin/orders/new` (spec §5.10): artwork, buyer, country, price (a change needs a reason),
 * currency, shipping, language, `conversation_took_place` (default true) and expiry →
 * `createLinkOrder(kind: 'MANUAL')`. Payment: the emailed link, or "Record payment" on the order.
 */
export default async function NewManualOrderPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/orders/new">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const sp = await searchParams;
  const preselect = Array.isArray(sp.artwork) ? sp.artwork[0] : sp.artwork;
  const t = await getTranslations({ locale, namespace: "admin-orders.new" });
  const tl = await getTranslations({ locale, namespace: "common.language" });
  const tm = await getTranslations({
    locale,
    namespace: "admin-shell.inbox.methods",
  });
  const works = await listSellableArtworks(ctx);
  const checkout = await getSetting("checkout");
  const shipping = await getSetting("shipping");
  const price = (minor: number | null) =>
    minor === null ? "—" : toDecimalString(minor);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link href={paths.admin.orders()} className="text-sm">
        {t("title")}
      </Link>
      <h1 className="text-3xl">{t("title")}</h1>
      <p>{t("intro")}</p>
      <ActionForm
        action={createManualOrderAction}
        locale={locale}
        submitLabel={t("submit")}
        errorNamespace="admin-orders.errors"
        confirm={{
          title: t("title"),
          message: t("confirm"),
          confirmLabel: t("submit"),
        }}
        testId="manual-order-form"
      >
        <FormField
          name="artworkId"
          label={t("artwork")}
          type="select"
          defaultValue={preselect ?? ""}
          placeholder={t("artworkPick")}
          options={works.map((w) => ({
            value: w.id,
            label: `${locale === "he" ? w.titleHe : w.titleEn} · ${w.inventoryNumber} · ₪${price(w.priceIlsMinor)}${w.priceUsdMinor ? ` / $${price(w.priceUsdMinor)}` : ""}`,
          }))}
          required
        />
        <fieldset className="flex flex-col gap-4">
          <legend className="font-sans font-semibold">{t("buyer")}</legend>
          <FormField name="name" label={t("name")} required />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="email" label={t("email")} type="email" required />
            <FormField name="phone" label={t("phone")} type="tel" />
          </div>
          <FormField
            name="buyerLocale"
            label={t("language")}
            type="select"
            defaultValue="he"
            options={[
              { value: "he", label: tl("he") },
              { value: "en", label: tl("en") },
            ]}
          />
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="country"
            label={t("country")}
            type="select"
            defaultValue="IL"
            options={countryOptions(locale, shipping.deniedCountries).map(
              (c) => ({
                value: c.code,
                label: c.name,
              }),
            )}
            required
          />
          <FormField
            name="currency"
            label={t("currency")}
            hint={t("currencyHint")}
            type="select"
            defaultValue="ILS"
            options={[
              { value: "ILS", label: "ILS ₪" },
              { value: "USD", label: "USD $" },
            ]}
          />
          <FormField
            name="price"
            label={t("price")}
            hint={t("priceHint")}
            type="number"
          />
          <FormField
            name="priceChangeReason"
            label={t("priceChangeReason")}
            hint={t("priceChangeHint")}
          />
          <FormField
            name="shippingMethod"
            label={t("shippingMethod")}
            type="select"
            defaultValue="CARRIER_TABLE"
            options={(
              [
                "CARRIER_TABLE",
                "QUOTED",
                "LOCAL_PICKUP",
                "ARTIST_DELIVERY",
              ] as const
            ).map((m) => ({
              value: m,
              label: tm(m),
            }))}
          />
          <FormField
            name="lockedShipping"
            label={t("lockedShipping")}
            type="number"
          />
          <FormField
            name="expiresInHours"
            label={t("expiresInHours")}
            type="number"
            inputMode="numeric"
            defaultValue={checkout.linkHoursDefault}
          />
        </div>
        <FormCheckbox
          name="conversationTookPlace"
          label={t("conversation")}
          hint={t("conversationHint")}
          defaultChecked
        />
      </ActionForm>
    </div>
  );
}
