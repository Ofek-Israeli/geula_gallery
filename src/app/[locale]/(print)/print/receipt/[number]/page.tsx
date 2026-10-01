import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Price } from "@/components/ui/Price";
import { formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { getBuyerTaxDocument } from "@/server/documents/buyer";
import { ipHashFrom } from "@/server/security/ip";
import { checkLimit } from "@/server/security/rate-limit";

/**
 * `/[locale]/print/receipt/[docNumber]?k=<order token>` (spec §4.3 `mock`): the HTML view of a mock
 * receipt or credit note, stamped "DEMO – not a tax document / הדגמה – אינו מסמך חשבונאי" in both
 * languages. A document issued by a real provider links to the provider's copy instead.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ReceiptPrintPage({
  params,
  searchParams,
}: PageProps<"/[locale]/print/receipt/[number]">) {
  const { locale, number } = await params;
  if (!isLocale(locale)) notFound();
  const k = (await searchParams).k;
  const doc = await getBuyerTaxDocument(
    decodeURIComponent(number),
    typeof k === "string" ? k : null,
    locale,
  );
  if (!doc) {
    await checkLimit(
      "badOrderKeyIp",
      ipHashFrom(await headers()) ?? "unknown-ip",
    );
    notFound();
  }
  const t = await getTranslations({
    locale,
    namespace: "documents-compliance.receipt",
  });
  const label = (l: (typeof doc.lines)[number]) =>
    l.kind === "item"
      ? l.title
      : l.kind === "order"
        ? t("line.order", { number: l.title })
        : t(`line.${l.kind}`);

  return (
    <article className="flex flex-col gap-6" data-testid="tax-document">
      {doc.isDemo ? (
        <p
          className="border-4 border-double border-reddot p-3 text-center text-xl font-semibold text-reddot"
          data-testid="demo-stamp"
        >
          <span lang="he" dir="rtl" className="block">
            הדגמה – אינו מסמך חשבונאי
          </span>
          <span lang="en" dir="ltr" className="block">
            DEMO – not a tax document
          </span>
        </p>
      ) : null}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl">
          {t(`kind.${doc.kind}`)}{" "}
          <bdi data-testid="doc-number">{doc.docNumber}</bdi>
        </h1>
        <p className="text-sm text-ink-muted">
          {t("meta", {
            number: doc.orderNumber,
            date: formatDateTime(doc.issuedAt, locale),
          })}
        </p>
        {doc.creditsDocNumber ? (
          <p className="text-sm">
            {t("credits", { doc: doc.creditsDocNumber })}
          </p>
        ) : null}
      </header>
      {doc.providerUrl && !doc.isDemo ? (
        <p>
          <a href={doc.providerUrl} className="underline">
            {t("providerCopy")}
          </a>
        </p>
      ) : null}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-sans font-semibold">{t("seller")}</h2>
          <p>
            <bdi>{doc.seller.legalName}</bdi>
          </p>
          <p>
            {t(doc.seller.vatMode === "OSEK_PATUR" ? "patur" : "murshe")}{" "}
            <bdi>{doc.seller.vatNumber ?? doc.seller.idNumber}</bdi>
          </p>
          <p>
            <bdi>{doc.seller.address}</bdi>
          </p>
        </div>
        <div className="flex flex-col gap-0.5">
          <h2 className="font-sans font-semibold">{t("buyer")}</h2>
          <p>
            <bdi>{doc.buyerName}</bdi>
          </p>
        </div>
      </section>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-start">
            <th className="py-1 text-start font-semibold">
              {t("description")}
            </th>
            <th className="py-1 text-end font-semibold">{t("amount")}</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={`${l.kind}:${l.title}`} className="border-b border-line">
              <td className="py-1">{label(l)}</td>
              <td className="py-1 text-end">
                <Price
                  amountMinor={l.amountMinor}
                  currency={doc.currency}
                  locale={locale}
                />
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-1 font-semibold">{t("total")}</td>
            <td className="py-1 text-end font-semibold">
              <Price
                amountMinor={doc.totalMinor}
                currency={doc.currency}
                locale={locale}
              />
            </td>
          </tr>
        </tbody>
      </table>
      {doc.payment && doc.kind !== "CREDIT_NOTE" ? (
        <p className="text-sm">
          {t("payment", {
            method: t.has(`method.${doc.payment.method}` as never)
              ? t(`method.${doc.payment.method}` as never)
              : t("method.card"),
            reference: doc.payment.reference ?? "—",
          })}
          {doc.payment.last4
            ? ` · ${t("last4", { last4: doc.payment.last4 })}`
            : ""}
        </p>
      ) : null}
    </article>
  );
}
