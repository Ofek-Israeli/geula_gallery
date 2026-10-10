import { getTranslations } from "next-intl/server";
import { Price } from "@/components/ui/Price";
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
