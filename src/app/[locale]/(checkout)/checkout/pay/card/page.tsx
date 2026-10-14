import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import {
  parseCheckoutParams,
  resolveCheckoutStep,
  stepLinks,
} from "@/lib/checkout-steps";
import { countryOptions } from "@/lib/countries";
import { isLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import { type CheckoutQuery, localePath, paths } from "@/lib/routes";
import { loadCart } from "@/server/cart/cart";
import { getArtworkPage } from "@/server/catalog/queries";
import { getCheckoutQuote } from "@/server/checkout/quote";
import { readCartIds } from "@/server/next/cart";
import { getSetting } from "@/server/settings";
import {
  OrderSummary,
  type SummaryLine,
  wasPriceOf,
} from "../../_components/parts";
import { CheckoutSteps } from "../../_components/steps";
import { CardForm } from "./CardForm";

/**
 * `/[locale]/checkout/pay/card?work=&to=&city=&zip=&ship=&pack=&cur=`: our own card payment page,
 * for the checkout while online card payment is not active (`CHECKOUT_PREVIEW` without a
 * provider). Step 3 opens it with a full page load once the server has validated the details
 * (the start refused only the provider, before writing anything). `work` is the "Buy now" work;
 * without it, the cart. The card form checks the card in the browser and sends nothing; no order,
 * hold or attempt exists. Served under a nonce CSP with no third-party origin (`src/proxy.ts`).
 * Anything else (a blocked work, an unfinished step, an active provider) goes back to step 3.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout/pay/card">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "checkout.card" });
  return {
    title: t("title"),
    robots: { index: false, follow: false },
    referrer: "strict-origin",
  };
}

export default async function CardPage({
  params,
  searchParams,
}: PageProps<"/[locale]/checkout/pay/card">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await connection();
  const sp = await searchParams;
  const p = parseCheckoutParams(sp);
  const work = typeof sp.work === "string" && sp.work ? sp.work : null;
  const base = {
    locale,
    country: p.country,
    method: p.ship ?? undefined,
    currency: p.cur ?? undefined,
    packing: p.pack === "rolled" ? ("ROLLED" as const) : undefined,
  };

  let quote: Awaited<ReturnType<typeof getCheckoutQuote>>;
  let lines: (q: Extract<typeof quote, { kind: "ok" }>) => SummaryLine[];
  if (work) {
    const [data, q] = await Promise.all([
      getArtworkPage(locale, work),
      getCheckoutQuote({ ...base, slug: work }),
    ]);
    if (!data) notFound();
    const { artwork } = data;
    const main = artwork.images[0] ?? null;
    quote = q;
    lines = (ok) =>
      ok.items.map((i) => ({
        id: i.artworkId,
        title: artwork.title,
        priceMinor: i.priceMinor,
        wasMinor: wasPriceOf(artwork.price, ok.currency),
        image: main,
        dimensions: {
          heightMm: artwork.heightMm,
          widthMm: artwork.widthMm,
          depthMm: artwork.depthMm,
        },
      }));
  } else {
    const cart = await loadCart(locale, await readCartIds());
    if (cart.readyIds.length === 0) redirect(localePath(locale, paths.cart()));
    const workOf = new Map(
      cart.lines
        .filter((l) => l.readiness === "ready")
        .map((l) => [l.work.id, l.work]),
    );
    quote = await getCheckoutQuote({ ...base, artworkIds: cart.readyIds });
    lines = (ok) =>
      ok.items.map((i) => {
        const w = workOf.get(i.artworkId);
        return {
          id: i.artworkId,
          title: w?.title ?? "",
          priceMinor: i.priceMinor,
          wasMinor: w ? wasPriceOf(w.price, ok.currency) : null,
          image: w?.image ?? null,
          ...(w
            ? {
                dimensions: {
                  heightMm: w.heightMm,
                  widthMm: w.widthMm,
                  depthMm: w.depthMm,
                },
              }
            : {}),
        };
      });
  }

  const href = (q: CheckoutQuery) =>
    work ? paths.checkout(work, q) : paths.cartCheckout(q);
  const query: CheckoutQuery = {
    to: p.country,
    city: p.city || undefined,
    zip: p.zip || undefined,
    ship: p.ship ?? undefined,
    pack: p.pack ?? undefined,
    cur: p.cur ?? undefined,
    step: "details",
  };
  if (quote.kind === "blocked") redirect(localePath(locale, href(query)));
  const shipping = await getSetting("shipping");
  const checkout = await getSetting("checkout");
  const countries = countryOptions(locale, shipping.deniedCountries);
  const r = resolveCheckoutStep(
    p,
    {
      methods: quote.methods.map((m) => m.method),
      selected: quote.shipping.method,
    },
    new Set(countries.map((c) => c.code)),
  );
  // Only while card payment is not active: with a provider, step 3 leads to its payment page.
  if (r.step !== "details" || quote.providers.length > 0) {
    redirect(localePath(locale, href(query)));
  }
  const links = stepLinks(href, {
    country: p.country,
    city: p.city,
    zip: p.zip,
    ship: r.offeredShip,
    cur: quote.currency === "USD" ? "USD" : null,
    pack: quote.packing === "ROLLED" ? "rolled" : null,
  });
  const t = await getTranslations({ locale, namespace: "checkout.card" });
  const maxInstallments =
    quote.country === "IL" && quote.currency === "ILS"
      ? Math.max(1, checkout.maxInstallments)
      : 1;

  return (
    <div className="flex flex-col gap-8" data-testid="card-page">
      <header className="flex flex-col gap-3">
        {/* Plain links: each page loads with its own security policy. */}
        <a href={localePath(locale, links.details)} className="text-sm">
          {t("back")}
        </a>
        <h1 className="text-4xl">{t("title")}</h1>
      </header>
      <CheckoutSteps current="details" locale={locale} />
      <p
        role="note"
        className="border-2 border-hold bg-white p-4 font-medium"
        data-testid="card-notice"
      >
        {t("notice")}
      </p>
      <OrderSummary quote={quote} locale={locale} lines={lines(quote)} />
      <CardForm
        payLabel={t("submit", {
          amount: formatMoney(quote.totalMinor, quote.currency, locale),
        })}
        maxInstallments={maxInstallments}
        contactHref={localePath(locale, paths.contact())}
      />
      <section
        aria-labelledby="card-secure-title"
        className="flex flex-col gap-2 border-s-2 border-line ps-4"
        data-testid="card-secure"
      >
        <h2 id="card-secure-title" className="text-lg font-medium">
          {t("secureTitle")}
        </h2>
        <ul className="max-w-prose list-disc ps-5 text-sm">
          <li>{t("secure.https")}</li>
          <li>{t("secure.notStored")}</li>
          <li>{t("secure.notSent")}</li>
        </ul>
      </section>
    </div>
  );
}
