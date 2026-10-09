import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PreContractDisclosure } from "@/components/checkout/PreContractDisclosure";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { countryOptions } from "@/lib/countries";
import { isLocale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";
import { getArtworkPage } from "@/server/catalog/queries";
import { getCheckoutQuote } from "@/server/checkout/quote";
import { issueFormStartToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { CheckoutForm } from "../_components/CheckoutForm";
import {
  DeliveryForm,
  deliveryQuery,
  OrderSummary,
  preContractDoc,
  providerOptions,
} from "../_components/parts";
import { startCheckoutAction } from "./actions";

/**
 * `/[locale]/checkout/[slug]?to=<CC>&ship=<METHOD>&cur=<ILS|USD>` ("Buy now", spec §5.1 step 2):
 * dynamic and noindex (checkout layout). Blocked states with CTAs; the delivery GET form (country,
 * method, currency, notices; works without JS); the details form with the pre-contract disclosure,
 * the unticked consents and the provider radios. No hold exists until "Continue to payment".
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
  const checkout = await getSetting("checkout");
  const countries = countryOptions(locale, shipping.deniedCountries);
  const checkoutPath = localePath(locale, paths.checkout(slug));
  const main = artwork.images[0] ?? null;

  const countryForm = (
    <DeliveryForm
      action={checkoutPath}
      country={country}
      countries={countries}
      quote={quote}
      locale={locale}
      ilsPerUsd={checkout.fx.ilsPerUsd}
    />
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

  const doc = await preContractDoc(
    quote,
    [
      {
        title: artwork.title,
        inventoryNumber: artwork.inventoryNumber,
        year: artwork.year,
        mediumText: artwork.mediumText,
        heightMm: artwork.heightMm,
        widthMm: artwork.widthMm,
        depthMm: artwork.depthMm,
        framed: artwork.framed,
        signed: artwork.signed,
        coaIncluded: artwork.coaIncluded,
        priceMinor: quote.itemsTotalMinor,
      },
    ],
    locale,
  );
  const s = quote.shipping;
  const international = quote.country !== "IL";

  return (
    <div className="flex flex-col gap-8">
      {header}

      <OrderSummary quote={quote} locale={locale} />

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
        itemCount={1}
        providers={await providerOptions(quote, locale)}
        disclosure={<PreContractDisclosure doc={doc} />}
        reloadHref={`${checkoutPath}?${new URLSearchParams(deliveryQuery(quote)).toString()}`}
      />
    </div>
  );
}
