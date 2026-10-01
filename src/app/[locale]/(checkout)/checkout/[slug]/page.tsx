import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PreContractDisclosure } from "@/components/checkout/PreContractDisclosure";
import { buttonClasses } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { Select } from "@/components/ui/Select";
import { buildPreContract } from "@/content/disclosure";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import { Link } from "@/i18n/navigation";
import { countryOptions } from "@/lib/countries";
import { isLocale, type Locale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import { localePath, paths } from "@/lib/routes";
import { getArtworkPage } from "@/server/catalog/queries";
import { getCheckoutQuote } from "@/server/checkout/quote";
import type { CheckoutQuote } from "@/server/checkout/types";
import { issueFormStartToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { startCheckoutAction } from "./actions";
import { CheckoutForm } from "./CheckoutForm";

/**
 * `/[locale]/checkout/[slug]?to=<CC>&ship=<METHOD>&cur=<ILS|USD>` (spec §5.1 step 2): dynamic and
 * noindex (checkout layout). Blocked states with CTAs; the delivery GET form (country, method,
 * currency, notices; works without JS); the details form with the pre-contract disclosure, the
 * unticked consents and the provider radios. No hold exists until "Continue to payment".
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout/[slug]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "checkout" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

const METHODS = ["CARRIER_TABLE", "LOCAL_PICKUP", "ARTIST_DELIVERY"] as const;
type Method = (typeof METHODS)[number];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const QUOTE_REASONS = new Set([
  "QUOTE_ONLY",
  "VALUE_CAP",
  "ZONE_DISABLED",
  "SIZE_QUOTE",
  "GB_LOW_VALUE",
  "NOT_PRICED",
]);
const DESTINATION_REASONS = new Set([
  "DESTINATION_DENIED",
  "ZONE_DISABLED",
  "NOT_INTERNATIONAL",
  "SIZE_QUOTE",
  "VALUE_CAP",
  "GB_LOW_VALUE",
  "NO_PROVIDER",
]);

export default async function CheckoutPage({
  params,
  searchParams,
}: PageProps<"/[locale]/checkout/[slug]">) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const country = (one(sp.to) ?? "IL").toUpperCase();
  const shipParam = one(sp.ship);
  const method = METHODS.includes(shipParam as Method)
    ? (shipParam as Method)
    : undefined;
  const cur = one(sp.cur) === "USD" ? "USD" : undefined;

  const [data, quote] = await Promise.all([
    getArtworkPage(locale, slug),
    getCheckoutQuote({ slug, locale, country, method, currency: cur }),
  ]);
  if (!data || (quote.kind === "blocked" && quote.artworkId === null)) {
    notFound();
  }
  const { artwork } = data;
  const t = await getTranslations({ locale, namespace: "checkout" });
  const shipping = await getSetting("shipping");
  const countries = countryOptions(locale, shipping.deniedCountries);
  const checkoutPath = localePath(locale, paths.checkout(slug));
  const main = artwork.images[0] ?? null;

  const countryForm = (
    <form
      method="get"
      action={checkoutPath}
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
        <DeliveryChoices quote={quote} locale={locale} />
      ) : null}
      <div>
        <button type="submit" className={buttonClasses("secondary", "sm")}>
          {t("delivery.update")}
        </button>
      </div>
    </form>
  );

  const header = (
    <header className="flex flex-col gap-3">
      <Link href={paths.artwork(slug)} className="text-sm">
        {t("back")}
      </Link>
      <h1 className="text-4xl">{t("title")}</h1>
      {artwork.isDemo ? (
        <p className="text-sm text-ink-muted">{t("demoNotice")}</p>
      ) : null}
      <div className="flex items-center gap-4">
        {main ? (
          <Image
            src={main.src}
            alt={main.alt}
            width={main.width}
            height={main.height}
            sizes="96px"
            className="h-24 w-24 object-contain"
          />
        ) : null}
        <div className="flex flex-col">
          <span className="font-serif text-xl">{artwork.title}</span>
          <span className="text-sm text-ink-muted">
            {[artwork.year, artwork.mediumText].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
    </header>
  );

  if (quote.kind === "blocked") {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <section
          aria-labelledby="blocked-title"
          className="flex flex-col gap-4 border border-line p-5"
          data-testid="checkout-blocked"
        >
          <h2 id="blocked-title" className="text-2xl">
            {t("blocked.title")}
          </h2>
          <p>{t(`blocked.${quote.reason}`)}</p>
          <div className="flex flex-wrap gap-3">
            {QUOTE_REASONS.has(quote.reason) ? (
              <Link
                href={paths.artworkRequest(slug, "quote")}
                className={buttonClasses("primary")}
              >
                {t("blocked.requestQuote")}
              </Link>
            ) : null}
            <Link
              href={paths.artworkRequest(slug, "question")}
              className={buttonClasses("secondary")}
            >
              {t("blocked.ask")}
            </Link>
          </div>
        </section>
        {DESTINATION_REASONS.has(quote.reason) ? (
          <section aria-label={t("blocked.otherCountry")}>
            {countryForm}
          </section>
        ) : null}
      </div>
    );
  }

  const [profile, checkout, policy] = await Promise.all([
    getSetting("business_profile"),
    getSetting("checkout"),
    getSetting("cancellation_policy"),
  ]);
  const international = quote.country !== "IL";
  const s = quote.shipping;
  const doc = buildPreContract(
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
      works: [
        {
          title: artwork.title,
          inventoryNumber: artwork.inventoryNumber,
          artistName: profile.artistName[locale],
          yearCreated: artwork.year,
          mediumText: artwork.mediumText,
          dimensions: {
            heightMm: artwork.heightMm,
            widthMm: artwork.widthMm,
            depthMm: artwork.depthMm,
          },
          framed: artwork.framed,
          signed: artwork.signed,
          coaIncluded: artwork.coaIncluded,
          priceMinor: quote.itemsTotalMinor,
        },
      ],
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

  const providers = quote.providers.map((p) => {
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
  const query: Record<string, string> = { to: quote.country, ship: s.method };
  if (quote.currency === "USD") query.cur = "USD";

  return (
    <div className="flex flex-col gap-8">
      {header}

      <section
        aria-labelledby="summary-title"
        className="flex flex-col gap-2 border border-line p-5"
        data-testid="checkout-summary"
      >
        <h2 id="summary-title" className="text-2xl">
          {t("summary.title")}
        </h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          <dt>{t("summary.items")}</dt>
          <dd>
            <Price
              amountMinor={quote.itemsTotalMinor}
              currency={quote.currency}
              locale={locale}
            />
          </dd>
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

      <section
        aria-labelledby="delivery-title"
        className="flex flex-col gap-4 border border-line p-5"
      >
        <h2 id="delivery-title" className="text-2xl">
          {t("delivery.title")}
        </h2>
        {countryForm}
        {quote.notices.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
            {quote.notices.map((n) => (
              <li key={n}>{t(`notices.${n}`)}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <CheckoutForm
        action={startCheckoutAction}
        locale={locale}
        hidden={{
          slug,
          country: quote.country,
          method: s.method,
          currency: quote.currency,
          expectedTotalMinor: quote.totalMinor,
          clientRequestId: randomUUID(),
          formStart: issueFormStartToken(),
        }}
        needsAddress={s.method !== "LOCAL_PICKUP"}
        international={international}
        holdMinutes={checkout.reservationMinutes}
        providers={providers}
        disclosure={<PreContractDisclosure doc={doc} />}
        reloadHref={`${checkoutPath}?${new URLSearchParams(query).toString()}`}
      />
    </div>
  );
}

async function DeliveryChoices({
  quote,
  locale,
}: {
  quote: Extract<CheckoutQuote, { kind: "ok" }>;
  locale: Locale;
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
                  amount: formatMoney(m.insuredValueMinor, "ILS", locale),
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
