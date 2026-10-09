import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { Select } from "@/components/ui/Select";
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
 * the delivery GET form (works without JS), the order summary (one line per work when there are
 * several), the payment options, and the pre-contract disclosure for one or more works.
 */
export type OkQuote = Extract<CheckoutQuote, { kind: "ok" }>;

export async function DeliveryForm({
  action,
  country,
  countries,
  quote,
  locale,
  ilsPerUsd,
}: {
  action: string;
  country: string;
  countries: { code: string; name: string }[];
  quote: CheckoutQuote;
  locale: Locale;
  ilsPerUsd: number;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  return (
    <form
      method="get"
      action={action}
      className="flex flex-col gap-4"
      data-testid="delivery-form"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="co-country" className="font-medium">
          {t("delivery.country")}
        </label>
        <Select
          id="co-country"
          name="to"
          defaultValue={country}
          options={countries.map((c) => ({ value: c.code, label: c.name }))}
        />
      </div>
      {quote.kind === "ok" ? (
        <DeliveryChoices quote={quote} locale={locale} ilsPerUsd={ilsPerUsd} />
      ) : null}
      <div>
        <button type="submit" className={buttonClasses("secondary", "sm")}>
          {t("delivery.update")}
        </button>
      </div>
    </form>
  );
}

async function DeliveryChoices({
  quote,
  locale,
  ilsPerUsd,
}: {
  quote: OkQuote;
  locale: Locale;
  ilsPerUsd: number;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="mbe-1 font-medium">
          {t("delivery.methodLegend")}
        </legend>
        {quote.methods.map((m) => {
          const id = `ship-${m.method}`;
          const price =
            m.shippingMinor + m.insuranceMinor === 0
              ? t("delivery.free")
              : formatMoney(
                  m.shippingMinor + m.insuranceMinor,
                  quote.currency,
                  locale,
                );
          const extras = [
            m.method === "CARRIER_TABLE" ? t("delivery.tracked") : null,
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
                defaultChecked={m.method === quote.shipping.method}
                className="mt-1 size-5 shrink-0 accent-ink"
              />
              <label htmlFor={id} className="flex flex-col">
                <span>
                  {t(`delivery.method.${m.method}`)} · <bdi>{price}</bdi>
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
      {quote.usdAvailable ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mbe-1 font-medium">
            {t("delivery.currency")}
          </legend>
          {(["ILS", "USD"] as const).map((c) => (
            <div key={c} className="flex items-center gap-3">
              <input
                id={`cur-${c}`}
                type="radio"
                name="cur"
                value={c}
                defaultChecked={quote.currency === c}
                className="size-5 accent-ink"
              />
              <label htmlFor={`cur-${c}`}>
                {t(
                  c === "ILS" ? "delivery.currencyIls" : "delivery.currencyUsd",
                )}
              </label>
            </div>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

/** The money summary; `lines` lists each work when the order has several. */
export async function OrderSummary({
  quote,
  locale,
  lines,
}: {
  quote: OkQuote;
  locale: Locale;
  lines?: { id: string; title: string; priceMinor: number }[];
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const s = quote.shipping;
  const international = quote.country !== "IL";
  return (
    <section
      aria-labelledby="summary-title"
      className="flex flex-col gap-2 border border-line p-5"
      data-testid="checkout-summary"
    >
      <h2 id="summary-title" className="text-2xl">
        {t("summary.title")}
      </h2>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        {lines && lines.length > 1 ? (
          lines.map((l) => (
            <div key={l.id} className="contents" data-testid="summary-line">
              <dt>{l.title}</dt>
              <dd>
                <Price
                  amountMinor={l.priceMinor}
                  currency={quote.currency}
                  locale={locale}
                />
              </dd>
            </div>
          ))
        ) : (
          <>
            <dt>{t("summary.items")}</dt>
            <dd>
              <Price
                amountMinor={quote.itemsTotalMinor}
                currency={quote.currency}
                locale={locale}
              />
            </dd>
          </>
        )}
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
      label: t(`provider.${p.id}`),
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

/** Query string that reproduces the current delivery choice (the "show the new total" link). */
export function deliveryQuery(quote: OkQuote): Record<string, string> {
  const query: Record<string, string> = {
    to: quote.country,
    ship: quote.shipping.method,
  };
  if (quote.currency === "USD") query.cur = "USD";
  return query;
}
