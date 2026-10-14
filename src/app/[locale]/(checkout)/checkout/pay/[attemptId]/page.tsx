import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { Dimensions } from "@/components/ui/Dimensions";
import { Price } from "@/components/ui/Price";
import { SalePrice } from "@/components/ui/SalePrice";
import { formatTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { formatMoney, toDecimalString } from "@/lib/money";
import { getPayPageView } from "@/server/checkout/pay-view";
import { env } from "@/server/env";
import { verifyHmacToken } from "@/server/security/tokens";
import { payWithCardAction } from "./actions";
import { PayForm } from "./PayForm";

/**
 * `/[locale]/checkout/pay/[attemptId]?t=` (Isracard): our own payment page, whose card fields are
 * PayMe's hosted fields (PCI SAQ A, iframe). Dynamic and noindex (checkout layout); served with a
 * per-request nonce CSP from `src/proxy.ts` that allows PayMe's script and frames and nothing else
 * from outside. `t` is the attempt's HMAC; an attempt already submitted goes to the order page.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/checkout/pay/[attemptId]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "checkout.pay" });
  return {
    title: t("title"),
    robots: { index: false, follow: false },
    referrer: "strict-origin",
  };
}

export default async function PayPage({
  params,
  searchParams,
}: PageProps<"/[locale]/checkout/pay/[attemptId]">) {
  const { locale, attemptId } = await params;
  if (!isLocale(locale)) notFound();
  await connection();
  const sp = await searchParams;
  const token = typeof sp.t === "string" ? sp.t : "";
  if (
    !/^[0-9a-f-]{36}$/i.test(attemptId) ||
    !verifyHmacToken("isracard-pay", attemptId, token)
  ) {
    notFound();
  }
  const view = await getPayPageView(attemptId, locale);
  if (!view) notFound();
  if (view.state === "done") redirect(view.orderUrl);
  const t = await getTranslations({ locale, namespace: "checkout" });
  const declined = sp.declined === "1";
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const international = view.international;

  return (
    <div className="flex flex-col gap-8" data-testid="pay-page">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl">{t("pay.title")}</h1>
        <p className="text-ink-muted">
          {t("pay.orderLine", { number: "" })}
          <bdi dir="ltr">{view.orderNumber}</bdi>
        </p>
      </header>

      {view.client?.testMode ? (
        <p
          role="note"
          className="border-2 border-hold bg-white p-4 font-medium"
          data-testid="pay-test-banner"
        >
          {t("pay.testBanner")}
        </p>
      ) : null}
      {declined && view.state === "ready" ? (
        <p
          role="alert"
          className="rounded-sm border-2 border-reddot bg-white p-4"
          data-testid="pay-declined"
        >
          {t("pay.declined")}
        </p>
      ) : null}

      <section
        aria-labelledby="pay-summary-title"
        className="flex flex-col gap-3 border border-line p-5"
        data-testid="checkout-summary"
      >
        <h2 id="pay-summary-title" className="text-2xl">
          {t("summary.title")}
        </h2>
        <ul className="flex flex-col gap-3">
          {view.items.map((i) => (
            <li
              key={i.id}
              className="flex items-start gap-3"
              data-testid="summary-line"
            >
              {i.image ? (
                <Image
                  src={i.image.src}
                  alt=""
                  width={i.image.width}
                  height={i.image.height}
                  sizes="56px"
                  className="h-14 w-14 shrink-0 object-contain"
                />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-serif">{i.title}</span>
                {i.dimensions ? (
                  <Dimensions
                    locale={locale}
                    heightMm={i.dimensions.heightMm}
                    widthMm={i.dimensions.widthMm}
                    depthMm={i.dimensions.depthMm}
                    className="text-sm text-ink-muted"
                  />
                ) : null}
                <span className="text-sm text-ink-muted">
                  {t("summary.qty")}
                </span>
              </div>
              <SalePrice
                amountMinor={i.priceMinor}
                wasMinor={i.wasMinor}
                currency={view.currency}
                locale={locale}
                className="shrink-0"
              />
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-line pbs-3">
          <dt>{t("summary.shipping")}</dt>
          <dd>
            {view.shippingMinor === 0 ? (
              t("summary.free")
            ) : (
              <Price
                amountMinor={view.shippingMinor}
                currency={view.currency}
                locale={locale}
              />
            )}
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
          <dd className="font-semibold" data-testid="checkout-total">
            <Price
              amountMinor={view.totalMinor}
              currency={view.currency}
              locale={locale}
            />
          </dd>
        </dl>
        <p className="text-sm text-ink-muted">
          {international
            ? t("summary.vatExport")
            : view.vatMinor > 0
              ? t("summary.vatIncluded", {
                  amount: formatMoney(view.vatMinor, view.currency, locale),
                })
              : t("summary.vatExempt")}
        </p>
      </section>

      {view.state === "expired" ? (
        <section
          className="flex flex-col items-start gap-3"
          data-testid="pay-expired"
        >
          <h2 className="text-2xl">{t("pay.expiredTitle")}</h2>
          <p>{t("pay.expiredBody")}</p>
          <a href={view.orderUrl} className={buttonClasses("secondary")}>
            {t("pay.backToOrder")}
          </a>
        </section>
      ) : !view.client ? (
        <p role="alert" data-testid="pay-not-configured">
          {t("pay.notConfigured")}
        </p>
      ) : (
        <>
          {view.holdUntil ? (
            <p className="flex flex-wrap items-center gap-2">
              {t("pay.holdUntil", { time: formatTime(view.holdUntil, locale) })}
              <Countdown until={view.holdUntil} className="font-semibold" />
            </p>
          ) : null}
          <PayForm
            action={payWithCardAction}
            locale={locale}
            attemptId={view.attemptId}
            token={token}
            client={view.client}
            nonce={nonce}
            amount={{
              value: toDecimalString(view.totalMinor),
              currency: view.currency,
              label: view.orderNumber,
            }}
            payLabel={t("pay.submit", {
              amount: formatMoney(view.totalMinor, view.currency, locale),
            })}
            maxInstallments={view.maxInstallments}
            prefill={view.prefill}
          />
          <section
            aria-labelledby="pay-secure-title"
            className="flex flex-col gap-2 border-s-2 border-line ps-4"
          >
            <h2 id="pay-secure-title" className="text-lg font-medium">
              {t("secure.title")}
            </h2>
            <p className="max-w-prose text-sm">{t("pay.secure")}</p>
            {env.PAYMENT_CARD_BRANDS.length > 0 ? (
              <p className="text-sm" data-testid="pay-cards">
                {t("secure.cards")}{" "}
                {env.PAYMENT_CARD_BRANDS.map((b, n) => (
                  <span key={b}>
                    {n > 0 ? " · " : null}
                    <span className="font-medium">{t(`cards.${b}`)}</span>
                  </span>
                ))}
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
