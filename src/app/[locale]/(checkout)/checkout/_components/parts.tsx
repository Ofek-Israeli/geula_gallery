import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { Dimensions } from "@/components/ui/Dimensions";
import { Price } from "@/components/ui/Price";
import { SalePrice } from "@/components/ui/SalePrice";
import { buildPreContract } from "@/content/disclosure";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import type { Locale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import { localePath, paths } from "@/lib/routes";
import { insuredValueForDisplay } from "@/server/checkout/pricing";
import type { CheckoutQuote } from "@/server/checkout/types";
import { getSetting } from "@/server/settings";

/**
 * Pieces shared by the "Buy now" checkout (`/checkout/[slug]`) and the cart checkout (`/checkout`):
 * the delivery option radios and notices (step 2), the order summary (one line per work when there
 * are several), the payment options, and the pre-contract disclosure for one or more works. The
 * step layout itself is in `./steps.tsx`.
 */
export type OkQuote = Extract<CheckoutQuote, { kind: "ok" }>;

/** One delivery option of a quote (the selected one is `quote.shipping`). */
export type MethodQuote = OkQuote["methods"][number];

/**
 * The name of a delivery option ("Courier", "Pickup from the studio"…). The step 2 radios and the
 * recap both use it, so a name that depends on the quote (its carrier, say) changes here only.
 */
export async function methodName(
  m: MethodQuote,
  locale: Locale,
): Promise<string> {
  const t = await getTranslations({ locale, namespace: "checkout" });
  // Abroad the courier is priced by DHL's published tariff: name the carrier.
  if (m.rateSource === "DHL_ESTIMATE") return t("delivery.method.DHL_EXPRESS");
  // Israel Post: home delivery in Israel, EMS abroad.
  if (m.israelPost?.service === "EMS") {
    return t("delivery.method.ISRAEL_POST_EMS");
  }
  return t(`delivery.method.${m.method}`);
}

/** "free", or the option's shipping plus insurance in the quote currency. */
export async function methodPriceLabel(
  m: MethodQuote,
  quote: OkQuote,
  locale: Locale,
): Promise<string> {
  const amount = m.shippingMinor + m.insuranceMinor;
  if (amount > 0) return formatMoney(amount, quote.currency, locale);
  const t = await getTranslations({ locale, namespace: "checkout" });
  return t("delivery.free");
}

/** The delivery option radios (`name="ship"`, ids `ship-<METHOD>`), priced in the quote currency. */
export async function MethodChoices({
  quote,
  locale,
  ilsPerUsd,
  checked,
}: {
  quote: OkQuote;
  locale: Locale;
  ilsPerUsd: number;
  /** The method checked when the page loads. */
  checked: string;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const options = await Promise.all(
    quote.methods.map(async (m) => ({
      m,
      name: await methodName(m, locale),
      price: await methodPriceLabel(m, quote, locale),
    })),
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mbe-1 font-medium">
        {t("delivery.methodLegend")}
      </legend>
      {options.map(({ m, name, price }) => {
        const id = `ship-${m.method}`;
        const extras = [
          m.method === "CARRIER_TABLE" || m.method === "ISRAEL_POST"
            ? t("delivery.tracked")
            : null,
          m.insured
            ? t("delivery.insuredUpTo", {
                amount: formatMoney(
                  insuredValueForDisplay(m, quote.currency, ilsPerUsd),
                  quote.currency,
                  locale,
                ),
              })
            : null,
          m.estimate?.[locale] || null,
        ].filter(Boolean);
        return (
          <div key={m.method} className="flex items-start gap-3">
            <input
              id={id}
              type="radio"
              name="ship"
              value={m.method}
              defaultChecked={m.method === checked}
              className="mt-1 size-5 shrink-0 accent-ink"
            />
            <label htmlFor={id} className="flex flex-col">
              <span>
                {name} · <bdi>{price}</bdi>
              </span>
              {extras.length ? (
                <span className="text-sm text-ink-muted">
                  {extras.join(" · ")}
                </span>
              ) : null}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** The quote's notices (duties, transit times…), if any. */
export async function DeliveryNotices({
  quote,
  locale,
}: {
  quote: OkQuote;
  locale: Locale;
}) {
  if (quote.notices.length === 0) return null;
  const t = await getTranslations({ locale, namespace: "checkout" });
  return (
    <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
      {quote.notices.map((n) => (
        <li key={n}>{t(`notices.${n}`)}</li>
      ))}
    </ul>
  );
}

/** One work in the order summary. `priceMinor` is the quote's (charged) price. */
export interface SummaryLine {
  id: string;
  title: string;
  priceMinor: number;
  /** The list price while a sale runs (shown struck through); null otherwise. */
  wasMinor?: number | null;
  image?: { src: string; alt: string; width: number; height: number } | null;
  dimensions?: { heightMm: number; widthMm: number; depthMm?: number | null };
}

/** The list price in the quote currency while a sale runs, for `SummaryLine.wasMinor`. */
export function wasPriceOf(
  price: { wasIlsMinor: number | null; wasUsdMinor: number | null },
  currency: OkQuote["currency"],
): number | null {
  return currency === "USD" ? price.wasUsdMinor : price.wasIlsMinor;
}

/**
 * The order summary: each work (thumbnail, title, dimensions, "original · qty 1", the sale price
 * with the list price struck through), then shipping, insurance, the total and the VAT line, in
 * the quote currency. Each original is unique, so the quantity is always 1.
 */
export async function OrderSummary({
  quote,
  locale,
  lines,
}: {
  quote: OkQuote;
  locale: Locale;
  lines: SummaryLine[];
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const s = quote.shipping;
  const international = quote.country !== "IL";
  return (
    <section
      aria-labelledby="summary-title"
      className="flex flex-col gap-3 border border-line p-5"
      data-testid="checkout-summary"
    >
      <h2 id="summary-title" className="text-2xl">
        {t("summary.title")}
      </h2>
      <ul className="flex flex-col gap-3">
        {lines.map((l) => (
          <li
            key={l.id}
            className="flex items-start gap-3"
            data-testid="summary-line"
          >
            {l.image ? (
              <Image
                src={l.image.src}
                alt=""
                width={l.image.width}
                height={l.image.height}
                sizes="56px"
                className="h-14 w-14 shrink-0 object-contain"
              />
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-serif">{l.title}</span>
              {l.dimensions ? (
                <Dimensions
                  locale={locale}
                  heightMm={l.dimensions.heightMm}
                  widthMm={l.dimensions.widthMm}
                  depthMm={l.dimensions.depthMm ?? null}
                  className="text-sm text-ink-muted"
                />
              ) : null}
              <span className="text-sm text-ink-muted">{t("summary.qty")}</span>
            </div>
            <SalePrice
              amountMinor={l.priceMinor}
              wasMinor={l.wasMinor ?? null}
              currency={quote.currency}
              locale={locale}
              className="shrink-0"
            />
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-line pbs-3">
        {lines.length > 1 ? (
          <>
            <dt>{t("summary.itemsTotal", { count: lines.length })}</dt>
            <dd>
              <Price
                amountMinor={quote.itemsTotalMinor}
                currency={quote.currency}
                locale={locale}
              />
            </dd>
          </>
        ) : null}
        <dt>{t("summary.shipping")}</dt>
        <dd>
          {s.shippingMinor === 0 ? (
            t("summary.free")
          ) : (
            <Price
              amountMinor={s.shippingMinor}
              currency={quote.currency}
              locale={locale}
            />
          )}
        </dd>
        {s.insuranceMinor > 0 ? (
          <>
            <dt>{t("summary.insurance")}</dt>
            <dd>
              <Price
                amountMinor={s.insuranceMinor}
                currency={quote.currency}
                locale={locale}
              />
            </dd>
          </>
        ) : null}
        <dt className="font-semibold">{t("summary.total")}</dt>
        <dd className="font-semibold" data-testid="checkout-total">
          <Price
            amountMinor={quote.totalMinor}
            currency={quote.currency}
            locale={locale}
          />
        </dd>
      </dl>
      <p className="text-sm text-ink-muted">
        {international
          ? t("summary.vatExport")
          : quote.vatMinor > 0
            ? t("summary.vatIncluded", {
                amount: formatMoney(quote.vatMinor, quote.currency, locale),
              })
            : t("summary.vatExempt")}
      </p>
    </section>
  );
}

/** Provider radios; Bit only for ILS totals up to ₪5,000. */
export async function providerOptions(quote: OkQuote, locale: Locale) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  return quote.providers.map((p) => {
    const wallets = p.wallets.filter(
      (w) =>
        w !== "bit" ||
        (quote.currency === "ILS" && quote.totalMinor <= 500_000),
    );
    return {
      id: p.id,
      label: `${t(`provider.${p.id}`)}${p.test ? t("provider.testSuffix") : ""}`,
      ...(wallets.length
        ? {
            description: t("provider.wallets", {
              list: wallets.map((w) => t(`provider.wallet.${w}`)).join(", "),
            }),
          }
        : {}),
    };
  });
}

export interface DisclosureWork {
  title: string;
  inventoryNumber: string;
  year: number | null;
  mediumText: string;
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
  framed: boolean;
  signed: boolean;
  coaIncluded: boolean;
  priceMinor: number;
}

/** The pre-contract disclosure (spec §5.1 step 2) for one or more works. */
export async function preContractDoc(
  quote: OkQuote,
  works: DisclosureWork[],
  locale: Locale,
) {
  const [profile, checkout, policy] = await Promise.all([
    getSetting("business_profile"),
    getSetting("checkout"),
    getSetting("cancellation_policy"),
  ]);
  const international = quote.country !== "IL";
  const s = quote.shipping;
  return buildPreContract(
    {
      seller: {
        legalName: profile.legalName,
        tradeName: profile.tradeName[locale],
        idNumber: profile.idNumber,
        vatMode: profile.vatMode,
        ...(profile.vatNumber ? { vatNumber: profile.vatNumber } : {}),
        address: profile.address[locale],
        phoneLocal: profile.phoneLocal,
        phoneIntl: profile.phoneIntl,
        email: profile.email,
      },
      works: works.map((w) => ({
        title: w.title,
        inventoryNumber: w.inventoryNumber,
        artistName: profile.artistName[locale],
        yearCreated: w.year,
        mediumText: w.mediumText,
        dimensions: {
          heightMm: w.heightMm,
          widthMm: w.widthMm,
          depthMm: w.depthMm,
        },
        framed: w.framed,
        signed: w.signed,
        coaIncluded: w.coaIncluded,
        priceMinor: w.priceMinor,
      })),
      currency: quote.currency,
      itemsTotalMinor: quote.itemsTotalMinor,
      shippingMinor: s.shippingMinor,
      insuranceMinor: s.insuranceMinor,
      totalMinor: quote.totalMinor,
      vatMinor: quote.vatMinor,
      zeroRatedExport: international,
      shippingMethod: s.method,
      ...(s.packing === "ROLLED" ? { rolled: true } : {}),
      deliveryEstimate: s.estimate?.[locale] ?? "",
      destinationCountry: quote.country,
      insured: s.insured,
      maxInstallments:
        quote.country === "IL" && quote.currency === "ILS"
          ? checkout.maxInstallments
          : 1,
      changeOfMindFee: policy.changeOfMindFee,
      international,
      links: {
        terms: localePath(locale, paths.legal("terms")),
        returns: localePath(locale, paths.legal("returns")),
        privacy: localePath(locale, paths.legal("privacy")),
        shipping: localePath(locale, paths.legal("shipping")),
        warranty: localePath(locale, paths.legal("warranty")),
        cancel: localePath(locale, paths.cancel()),
      },
      versions: {
        terms: LEGAL_VERSIONS.terms,
        returns: LEGAL_VERSIONS.returns,
        privacy: LEGAL_VERSIONS.privacy,
      },
    },
    locale,
  );
}
