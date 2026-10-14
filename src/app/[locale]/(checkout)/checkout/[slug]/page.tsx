import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PreContractDisclosure } from "@/components/checkout/PreContractDisclosure";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import {
  parseCheckoutParams,
  resolveCheckoutStep,
  stepLinks,
} from "@/lib/checkout-steps";
import { countryName, countryOptions } from "@/lib/countries";
import { isLocale } from "@/lib/locale";
import { type CheckoutQuery, localePath, paths } from "@/lib/routes";
import { getArtworkPage } from "@/server/catalog/queries";
import { getCheckoutQuote } from "@/server/checkout/quote";
import { issueFormStartToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { CheckoutForm } from "../_components/CheckoutForm";
import {
  OrderSummary,
  preContractDoc,
  providerOptions,
} from "../_components/parts";
import {
  CheckoutSteps,
  DeliveryStep,
  DestinationForm,
  DestinationStep,
  DetailsIntro,
} from "../_components/steps";
import { startCheckoutAction } from "./actions";

/**
 * `/[locale]/checkout/[slug]?to=&city=&zip=&ship=&pack=&cur=&step=` ("Buy now", spec §5.1 step 2):
 * dynamic and noindex (checkout layout); `strict-origin` keeps the destination in the query out of
 * Referer headers. The address-first steps of `src/lib/checkout-steps.ts`: 1. country, city and
 * postal code (GET form) → 2. the priced delivery options, the packing (stretched or rolled in a
 * tube, when a work allows it) and the currency (GET form) → 3. the
 * details form with the street address only for a delivery, the pre-contract disclosure, the
 * unticked consents and the provider radios. Blocked states keep their CTAs and, for destination
 * reasons, the step 1 form. No hold exists until "Continue to payment".
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout/[slug]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "checkout" });
  return {
    title: t("title"),
    robots: { index: false, follow: false },
    referrer: "strict-origin",
  };
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
  const p = parseCheckoutParams(await searchParams);

  const [data, quote] = await Promise.all([
    getArtworkPage(locale, slug),
    getCheckoutQuote({
      slug,
      locale,
      country: p.country,
      method: p.ship ?? undefined,
      currency: p.cur ?? undefined,
      packing: p.pack === "rolled" ? "ROLLED" : undefined,
    }),
  ]);
  if (!data || (quote.kind === "blocked" && quote.artworkId === null)) {
    notFound();
  }
  const { artwork } = data;
  const t = await getTranslations({ locale, namespace: "checkout" });
  const shipping = await getSetting("shipping");
  const checkout = await getSetting("checkout");
  const countries = countryOptions(locale, shipping.deniedCountries);
  const action = localePath(locale, paths.checkout(slug));
  const href = (q: CheckoutQuery) => paths.checkout(slug, q);
  const main = artwork.images[0] ?? null;

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
            <DestinationForm
              action={action}
              locale={locale}
              countries={countries}
              value={{ country: p.country, city: p.city, zip: p.zip }}
              carry={{ ship: p.ship, cur: p.cur, pack: p.pack }}
              issues={{}}
            />
          </section>
        ) : null}
      </div>
    );
  }

  const r = resolveCheckoutStep(
    p,
    {
      methods: quote.methods.map((m) => m.method),
      selected: quote.shipping.method,
    },
    new Set(countries.map((c) => c.code)),
  );
  const links = stepLinks(href, {
    country: p.country,
    city: p.city,
    zip: p.zip,
    ship: r.offeredShip,
    cur: quote.currency === "USD" ? "USD" : null,
    pack: quote.packing === "ROLLED" ? "rolled" : null,
  });
  const destination = {
    country: p.country,
    countryName: countryName(p.country, locale),
    city: p.city,
    zip: p.zip,
  };

  if (r.step === "destination") {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <CheckoutSteps current="destination" locale={locale} />
        <DestinationStep
          action={action}
          locale={locale}
          countries={countries}
          value={{ country: p.country, city: p.city, zip: p.zip }}
          carry={{ ship: p.ship, cur: p.cur, pack: p.pack }}
          issues={r.showDestinationErrors ? r.issues : {}}
        />
      </div>
    );
  }

  if (r.step === "delivery") {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <CheckoutSteps current="delivery" locale={locale} />
        <DeliveryStep
          action={action}
          locale={locale}
          quote={quote}
          ilsPerUsd={checkout.fx.ilsPerUsd}
          itemCount={1}
          destination={destination}
          links={links}
          checked={r.checkedMethod}
          problem={r.deliveryProblem}
        />
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
  const needsAddress = s.method !== "LOCAL_PICKUP";

  return (
    <div className="flex flex-col gap-8">
      {header}
      <CheckoutSteps current="details" locale={locale} />
      <DetailsIntro
        quote={quote}
        locale={locale}
        destination={destination}
        links={links}
      />
      <OrderSummary quote={quote} locale={locale} />
      <CheckoutForm
        action={startCheckoutAction}
        locale={locale}
        hidden={{
          slug,
          country: quote.country,
          method: s.method,
          currency: quote.currency,
          ...(quote.packing === "ROLLED" ? { packing: "ROLLED" as const } : {}),
          ...(needsAddress
            ? { city: p.city, postalCode: p.zip || undefined }
            : {}),
          expectedTotalMinor: quote.totalMinor,
          clientRequestId: randomUUID(),
          formStart: issueFormStartToken(),
        }}
        destination={{
          city: p.city,
          postalCode: p.zip,
          countryName: destination.countryName,
        }}
        needsAddress={needsAddress}
        international={quote.country !== "IL"}
        holdMinutes={checkout.reservationMinutes}
        itemCount={1}
        providers={await providerOptions(quote, locale)}
        disclosure={<PreContractDisclosure doc={doc} />}
        reloadHref={localePath(locale, links.details)}
        changeDestinationHref={localePath(locale, links.destination)}
        contactHref={localePath(locale, paths.contact())}
      />
    </div>
  );
}
