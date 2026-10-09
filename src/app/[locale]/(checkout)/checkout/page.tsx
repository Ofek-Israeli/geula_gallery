import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PreContractDisclosure } from "@/components/checkout/PreContractDisclosure";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { countryOptions } from "@/lib/countries";
import { LOCALE_FIELD } from "@/lib/forms";
import { isLocale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";
import { loadCart } from "@/server/cart/cart";
import { getCheckoutQuote } from "@/server/checkout/quote";
import { readCartIds } from "@/server/next/cart";
import { issueFormStartToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { removeFromCartAction } from "../../(site)/cart/actions";
import { CheckoutForm } from "./_components/CheckoutForm";
import {
  DeliveryForm,
  deliveryQuery,
  OrderSummary,
  preContractDoc,
  providerOptions,
} from "./_components/parts";
import { startCartCheckoutAction } from "./actions";

/**
 * `/[locale]/checkout?to=<CC>&ship=<METHOD>&cur=<ILS|USD>`: the cart checkout. Every ready work of
 * the cart in one order — one delivery choice for all of them, one payment. Works that are not
 * ready stay in the cart (and are named here); a work that blocks the delivery is named with a
 * "Remove from cart" button. No hold exists until "Continue to payment".
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout">): Promise<Metadata> {
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

const DESTINATION_REASONS = new Set([
  "DESTINATION_DENIED",
  "ZONE_DISABLED",
  "NOT_INTERNATIONAL",
  "SIZE_QUOTE",
  "VALUE_CAP",
  "GB_LOW_VALUE",
  "NO_PROVIDER",
  "QUOTE_ONLY",
]);

export default async function CartCheckoutPage({
  params,
  searchParams,
}: PageProps<"/[locale]/checkout">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const country = (one(sp.to) ?? "IL").toUpperCase();
  const shipParam = one(sp.ship);
  const method = METHODS.includes(shipParam as Method)
    ? (shipParam as Method)
    : undefined;
  const cur = one(sp.cur) === "USD" ? "USD" : undefined;

  const cart = await loadCart(locale, await readCartIds());
  if (cart.readyIds.length === 0) redirect(localePath(locale, paths.cart()));
  const ready = cart.lines.filter((l) => l.readiness === "ready");
  const excluded = cart.lines.length - ready.length;
  const quote = await getCheckoutQuote({
    artworkIds: cart.readyIds,
    locale,
    country,
    method,
    currency: cur,
  });

  const t = await getTranslations({ locale, namespace: "checkout" });
  const shipping = await getSetting("shipping");
  const checkout = await getSetting("checkout");
  const countries = countryOptions(locale, shipping.deniedCountries);
  const checkoutPath = localePath(locale, paths.cartCheckout());
  const titleOf = new Map(ready.map((l) => [l.work.id, l.work.title]));
  const currentQuery = new URLSearchParams(
    Object.entries({ to: country, ship: method ?? "", cur: cur ?? "" }).filter(
      ([, v]) => v !== "",
    ),
  ).toString();

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
      <Link href={paths.cart()} className="text-sm">
        {t("cart.back")}
      </Link>
      <h1 className="text-4xl">{t("title")}</h1>
      {ready.some((l) => l.work.isDemo) ? (
        <p className="text-sm text-ink-muted">{t("demoNotice")}</p>
      ) : null}
      {excluded > 0 ? (
        <p role="status" data-testid="checkout-excluded">
          {t("cart.excluded", { count: excluded })}{" "}
          <Link href={paths.cart()} className="underline">
            {t("cart.back")}
          </Link>
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-4" data-testid="checkout-works">
        {ready.map((l) => (
          <li key={l.work.id} className="flex items-center gap-3">
            {l.work.image ? (
              <Image
                src={l.work.image.src}
                alt={l.work.image.alt}
                width={l.work.image.width}
                height={l.work.image.height}
                sizes="64px"
                className="h-16 w-16 object-contain"
              />
            ) : null}
            <span className="font-serif">{l.work.title}</span>
          </li>
        ))}
      </ul>
    </header>
  );

  if (quote.kind === "blocked") {
    const named = quote.problems.filter((p) => titleOf.has(p.artworkId));
    const message =
      quote.reason === "VALUE_CAP" && named.length === 0
        ? t("blocked.VALUE_CAP_CART")
        : t(`blocked.${quote.reason}`);
    return (
      <div className="flex flex-col gap-8">
        {header}
        <section
          aria-labelledby="blocked-title"
          className="flex flex-col gap-4 border border-line p-5"
          data-testid="checkout-blocked"
        >
          <h2 id="blocked-title" className="text-2xl">
            {t("blocked.cartTitle")}
          </h2>
          {named.length === 0 ? <p>{message}</p> : null}
          {named.length > 0 ? (
            <ul className="flex flex-col gap-3" data-testid="checkout-problems">
              {named.map((p) => {
                const title = titleOf.get(p.artworkId) ?? "";
                return (
                  <li
                    key={p.artworkId}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <span>
                      <span className="font-serif">{title}</span>
                      {" – "}
                      {t(`cart.problem.${p.reason}`)}
                    </span>
                    <form action={removeFromCartAction}>
                      <input type="hidden" name={LOCALE_FIELD} value={locale} />
                      <input
                        type="hidden"
                        name="artworkId"
                        value={p.artworkId}
                      />
                      <input type="hidden" name="returnTo" value="checkout" />
                      <input type="hidden" name="query" value={currentQuery} />
                      <button
                        type="submit"
                        className={buttonClasses("secondary", "sm")}
                        aria-label={t("cart.removeFromCartLabel", { title })}
                      >
                        {t("cart.removeFromCart")}
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div>
            <Link
              href={paths.contact()}
              className={buttonClasses("secondary", "sm")}
            >
              {t("blocked.requestQuote")}
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

  const priceOf = new Map(quote.items.map((i) => [i.artworkId, i.priceMinor]));
  const doc = await preContractDoc(
    quote,
    ready.map((l) => ({
      title: l.work.title,
      inventoryNumber: l.work.inventoryNumber,
      year: l.work.year,
      mediumText: l.work.mediumText,
      heightMm: l.work.heightMm,
      widthMm: l.work.widthMm,
      depthMm: l.work.depthMm,
      framed: l.work.framed,
      signed: l.work.signed,
      coaIncluded: l.work.coaIncluded,
      priceMinor: priceOf.get(l.work.id) ?? 0,
    })),
    locale,
  );
  const s = quote.shipping;
  const international = quote.country !== "IL";

  return (
    <div className="flex flex-col gap-8">
      {header}

      <OrderSummary
        quote={quote}
        locale={locale}
        lines={quote.items.map((i) => ({
          id: i.artworkId,
          title: titleOf.get(i.artworkId) ?? "",
          priceMinor: i.priceMinor,
        }))}
      />

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
        action={startCartCheckoutAction}
        locale={locale}
        hidden={{
          items: quote.items.map((i) => `${i.artworkId}:${i.priceMinor}`),
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
        itemCount={quote.items.length}
        itemTitles={Object.fromEntries(titleOf)}
        providers={await providerOptions(quote, locale)}
        disclosure={<PreContractDisclosure doc={doc} />}
        reloadHref={`${checkoutPath}?${new URLSearchParams(deliveryQuery(quote)).toString()}`}
      />
    </div>
  );
}
