import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { isLocale } from "@/lib/locale";
import { env } from "@/server/env";
import {
  mockPaymentView,
  mockProviderAllowed,
} from "@/server/payments/providers/mock";

/**
 * `/[locale]/mock-pay/[ref]` (spec §4.2 `mock`): the mock provider's hosted page. It reads
 * "MOCK PAYMENT – no real money / תשלום הדגמה – ללא חיוב", shows merchant, amount and order
 * number, and has six buttons: Pay, Approve only, Mark under review, Decline, Cancel, Pay without
 * returning. Every button also sends the signed webhook.
 */
export const metadata: Metadata = {
  title: "MOCK PAYMENT",
  robots: { index: false, follow: false },
};

export default async function MockPayPage({
  params,
  searchParams,
}: PageProps<"/[locale]/mock-pay/[ref]">) {
  const { locale, ref } = await params;
  if (!isLocale(locale) || !mockProviderAllowed(env)) notFound();
  const view = await mockPaymentView(decodeURIComponent(ref));
  if (!view) notFound();
  const sp = await searchParams;
  const t = await getTranslations({ locale, namespace: "checkout.mockPay" });
  const buttons = [
    ["pay", t("pay"), "primary"],
    ["approve", t("approve"), "secondary"],
    ["review", t("review"), "secondary"],
    ["decline", t("decline"), "secondary"],
    ["cancel", t("cancel"), "ghost"],
    ["pay_no_return", t("payNoReturn"), "ghost"],
  ] as const;

  return (
    <div className="flex flex-col gap-6 border-4 border-dashed border-reddot p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl" lang="en" dir="ltr">
          {t("title")}
        </h1>
        <p className="text-2xl" lang="he" dir="rtl">
          {t("titleHe")}
        </p>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-ink-muted">{t("merchant")}</dt>
        <dd>{t("merchantName")}</dd>
        <dt className="text-ink-muted">{t("amount")}</dt>
        <dd data-testid="mock-amount">
          <Price
            amountMinor={view.amountMinor}
            currency={view.currency}
            locale={locale}
          />
        </dd>
        <dt className="text-ink-muted">{t("order")}</dt>
        <dd>
          <bdi>{view.orderNumber ?? "—"}</bdi>
        </dd>
        <dt className="text-ink-muted">{t("flow")}</dt>
        <dd>
          <bdi>{view.flow}</bdi>
        </dd>
        <dt className="text-ink-muted">{t("state")}</dt>
        <dd data-testid="mock-state">
          <bdi>{view.state}</bdi>
        </dd>
      </dl>
      {sp.done ? (
        <p role="status" className="font-medium">
          {t("done")}
        </p>
      ) : null}
      {view.state === "OPEN" ? (
        <form
          method="post"
          action="/api/mock-pay"
          className="flex flex-wrap gap-3"
        >
          <input type="hidden" name="ref" value={view.ref} />
          <input type="hidden" name="locale" value={locale} />
          {buttons.map(([op, label, variant]) => (
            <button
              key={op}
              type="submit"
              name="op"
              value={op}
              className={buttonClasses(variant)}
              data-testid={`mock-${op}`}
            >
              {label}
            </button>
          ))}
        </form>
      ) : sp.done ? null : (
        <p role="status">{t("closed", { state: view.state })}</p>
      )}
    </div>
  );
}
