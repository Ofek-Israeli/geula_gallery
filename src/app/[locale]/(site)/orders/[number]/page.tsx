import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { Countdown } from "@/components/ui/Countdown";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { countryName } from "@/lib/countries";
import { formatTime } from "@/lib/format";
import { LOCALE_FIELD } from "@/lib/forms";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { getBuyerOrder } from "@/server/checkout/order-view";
import { ipHashFrom } from "@/server/security/ip";
import { checkLimit } from "@/server/security/rate-limit";
import { payOrderAction, releaseHoldAction } from "./actions";

/**
 * `/[locale]/orders/[number]?k=<token>` (spec §5.1 step 4; noindex; `strict-origin` rather than
 * `no-referrer`, see next.config.ts: `no-referrer` makes form POSTs carry `Origin: null`). AWAITING_PAYMENT:
 * countdown, attempt status (5 s meta refresh while a payment is settling, up to 2 min), "Pay" and
 * "Release my hold", both refused while a payment is being confirmed. Other states: review, paid
 * (with a prefilled cancellation link), expired, cancelled. A bad token is rate limited and 404s.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "strict-origin",
};

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function OrderPage({
  params,
  searchParams,
}: PageProps<"/[locale]/orders/[number]">) {
  const { locale, number } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const k = one(sp.k) ?? null;
  const view = await getBuyerOrder(decodeURIComponent(number), k, locale);
  if (!view) {
    await checkLimit(
      "badOrderKeyIp",
      ipHashFrom(await headers()) ?? "unknown-ip",
    );
    notFound();
  }
  const t = await getTranslations({ locale, namespace: "orders" });
  const payment = one(sp.payment);
  const err = one(sp.err);
  const settling =
    view.recentPending || view.attempts.some((a) => a.status === "CAPTURING");
  const hidden = (
    <>
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name="number" value={view.number} />
      <input type="hidden" name="k" value={view.accessToken} />
    </>
  );
  const firstSlug = view.items[0]?.slug ?? null;

  return (
    <div className="flex max-w-3xl flex-col gap-8" data-testid="order-page">
      {settling ? <meta httpEquiv="refresh" content="5" /> : null}
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl">
          {t("title", { number: "" })}
          <bdi data-testid="order-number">{view.number}</bdi>
        </h1>
        <p className="text-xl" data-testid="order-status">
          {t(`status.${view.status}`)}
        </p>
      </header>

      {payment && t.has(`payment.${payment}` as never) ? (
        <p
          role="status"
          className="border border-line p-4"
          data-testid="payment-result"
        >
          {t(`payment.${payment}` as never)}
        </p>
      ) : null}
      {err ? (
        <p
          role="alert"
          className="border-2 border-reddot p-4"
          data-testid="order-error"
        >
          {t.has(`errors.${err}` as never)
            ? t(`errors.${err}` as never)
            : t("errors.generic")}
        </p>
      ) : null}
      {one(sp.released) ? <p role="status">{t("released")}</p> : null}

      {view.status === "AWAITING_PAYMENT" ? (
        <section
          className="flex flex-col gap-4"
          aria-label={t("status.AWAITING_PAYMENT")}
        >
          {view.holdUntil ? (
            <p className="flex flex-wrap items-center gap-2">
              {t("holdUntil", { time: formatTime(view.holdUntil, locale) })}
              <Countdown until={view.holdUntil} className="font-semibold" />
            </p>
          ) : (
            <p>{t("holdLapsed")}</p>
          )}
          {view.inFlight ? (
            <p role="status">{t("inFlight")}</p>
          ) : settling ? (
            <p role="status">{t("checking")}</p>
          ) : null}
          {view.canPay ? (
            <form action={payOrderAction} className="flex flex-col gap-3">
              {hidden}
              {view.providers.length > 1 ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="font-medium">{t("provider")}</legend>
                  {view.providers.map((p, i) => (
                    <label key={p} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="providerId"
                        value={p}
                        defaultChecked={i === 0}
                        className="size-5 accent-ink"
                      />
                      {p}
                    </label>
                  ))}
                </fieldset>
              ) : (
                <input
                  type="hidden"
                  name="providerId"
                  value={view.providers[0] ?? "mock"}
                />
              )}
              <div>
                <button
                  type="submit"
                  className={buttonClasses("primary")}
                  data-testid="pay-now"
                >
                  {t("payNow")}
                </button>
              </div>
            </form>
          ) : null}
          {view.canRelease && view.holdUntil ? (
            <form action={releaseHoldAction}>
              {hidden}
              <ConfirmButton message={t("releaseConfirm")} variant="secondary">
                {t("release")}
              </ConfirmButton>
            </form>
          ) : null}
        </section>
      ) : null}

      {view.status === "PAYMENT_REVIEW" ? <p>{t("review.body")}</p> : null}
      {view.status === "PAID" || view.status === "COMPLETED" ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-2xl">{t("paid.title")}</h2>
          <p>{t("paid.body")}</p>
          <p>
            <Link href={paths.cancel(view.number)}>{t("paid.cancel")}</Link>
          </p>
        </section>
      ) : null}
      {view.status === "EXPIRED" ? (
        <section className="flex flex-col gap-2">
          <p>{t("expired.body")}</p>
          {firstSlug ? (
            <p>
              <Link href={paths.artwork(firstSlug)}>{t("expired.again")}</Link>
            </p>
          ) : null}
        </section>
      ) : null}
      {view.status === "CANCELLED" ? <p>{t("cancelled.body")}</p> : null}

      <section
        aria-labelledby="order-summary"
        className="flex flex-col gap-2 border border-line p-5"
      >
        <h2 id="order-summary" className="text-2xl">
          {t("summary.title")}
        </h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          {view.items.map((i) => (
            <div key={i.title} className="contents">
              <dt>{i.title}</dt>
              <dd>
                <Price
                  amountMinor={i.priceMinor}
                  currency={view.currency}
                  locale={locale}
                />
              </dd>
            </div>
          ))}
          <dt>{t("summary.shipping")}</dt>
          <dd>
            <Price
              amountMinor={view.shippingMinor}
              currency={view.currency}
              locale={locale}
            />
          </dd>
          {view.insuranceMinor > 0 ? (
            <>
              <dt>{t("summary.insurance")}</dt>
              <dd>
                <Price
                  amountMinor={view.insuranceMinor}
                  currency={view.currency}
                  locale={locale}
                />
              </dd>
            </>
          ) : null}
          <dt className="font-semibold">{t("summary.total")}</dt>
          <dd className="font-semibold">
            <Price
              amountMinor={view.totalMinor}
              currency={view.currency}
              locale={locale}
            />
          </dd>
          <dt>{t("summary.destination")}</dt>
          <dd>{countryName(view.shipCountry, locale)}</dd>
        </dl>
      </section>

      {view.attempts.length > 0 ? (
        <section
          aria-labelledby="order-attempts"
          className="flex flex-col gap-2"
        >
          <h2 id="order-attempts" className="text-xl">
            {t("attempts.title")}
          </h2>
          <ol
            className="flex flex-col gap-1 text-sm"
            data-testid="order-attempts"
          >
            {view.attempts.map((a) => (
              <li key={a.seq}>
                #{a.seq} · {t(`attempts.status.${a.status}`)} ·{" "}
                <bdi>{formatTime(a.createdAt, locale)}</bdi>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
