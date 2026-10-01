import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { formatDate } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import { requireAdmin } from "@/server/next/guards";
import { getCommercialInvoice } from "@/server/shipping/documents";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/[locale]/print/admin/commercial-invoice/[orderId]` (spec §5.4, §4.4 "Customs"): always in
 * English (customs), A4. Exporter and consignee, CI-<order>, DAP, permanent export, HS 9701.91
 * with the outbound and destination codes, origin IL, values, parcels and weight, the export
 * declaration, the EU 2019/880 statement for EU destinations, the origin statement and a
 * signature line. requireAdmin here AND in the print/admin layout.
 */
export default async function CommercialInvoicePage({
  params,
}: PageProps<"/[locale]/print/admin/commercial-invoice/[orderId]">) {
  const { locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const ci = await getCommercialInvoice(ctx, orderId);
  if (!ci) notFound();
  const t = await getTranslations({
    locale: "en",
    namespace: "documents-shipping.commercialInvoice",
  });
  const money = (minor: number) => formatMoney(minor, ci.currency, "en");
  const exportStatus =
    ci.exportDeclaration.status === "RECORDED"
      ? t("exportStatus.RECORDED", {
          number: ci.exportDeclaration.number ?? "",
        })
      : t(`exportStatus.${ci.exportDeclaration.status}` as never);
  const party = (p: typeof ci.consignee) => (
    <address className="not-italic">
      <span className="block font-medium">{p.name}</span>
      {p.company ? <span className="block">{p.company}</span> : null}
      {p.lines.map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
      {p.phone ? <span className="block">{p.phone}</span> : null}
      {p.email ? <span className="block">{p.email}</span> : null}
    </address>
  );
  return (
    <article
      lang="en"
      dir="ltr"
      className="flex flex-col gap-5 text-sm"
      data-testid="commercial-invoice"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pbe-3">
        <h1 className="text-2xl">{t("title")}</h1>
        <dl className="grid grid-cols-2 gap-x-4">
          <dt>{t("invoiceNumber")}</dt>
          <dd data-testid="ci-number">{ci.invoiceNumber}</dd>
          <dt>{t("invoiceDate")}</dt>
          <dd>{formatDate(ci.invoiceDate, "en")}</dd>
          <dt>{t("orderNumber")}</dt>
          <dd>{ci.orderNumber}</dd>
          <dt>{t("waybill")}</dt>
          <dd>{ci.waybill ?? t("notShipped")}</dd>
          <dt>{t("carrier")}</dt>
          <dd>{ci.carrierName ?? t("none")}</dd>
        </dl>
      </header>
      <div className="grid grid-cols-2 gap-6">
        <section>
          <h2 className="font-semibold">{t("exporter")}</h2>
          {party(ci.exporter)}
          <p>{ci.exporter.idLine}</p>
        </section>
        <section>
          <h2 className="font-semibold">{t("consignee")}</h2>
          {party(ci.consignee)}
        </section>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt>{t("origin")}</dt>
        <dd>Israel (IL)</dd>
        <dt>{t("destination")}</dt>
        <dd>{ci.destination}</dd>
        <dt>{t("incoterm")}</dt>
        <dd>
          {ci.incoterm} – {t("incotermNote")}
        </dd>
        <dt>{t("reason")}</dt>
        <dd>{ci.reasonForExport}</dd>
        <dt>{t("currency")}</dt>
        <dd>{ci.currency}</dd>
      </dl>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink">
            <th className="py-1 text-start">{t("description")}</th>
            <th className="py-1 text-start">{t("hsCode")}</th>
            <th className="py-1 text-start">{t("codes")}</th>
            <th className="py-1 text-start">{t("origin")}</th>
            <th className="py-1 text-end">{t("qty")}</th>
            <th className="py-1 text-end">{t("unitValue")}</th>
            <th className="py-1 text-end">{t("total")}</th>
          </tr>
        </thead>
        <tbody>
          {ci.lines.map((l) => (
            <tr key={l.description} className="border-b border-line align-top">
              <td className="py-1 pe-2">{l.description}</td>
              <td className="py-1">{l.hsCode}</td>
              <td className="py-1" data-testid="ci-codes">
                {`${l.exportCode} / ${l.importCode}`}
              </td>
              <td className="py-1">{l.origin}</td>
              <td className="py-1 text-end">{l.quantity}</td>
              <td className="py-1 text-end">{money(l.unitValueMinor)}</td>
              <td className="py-1 text-end">
                {money(l.unitValueMinor * l.quantity)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6} className="py-1 text-end">
              {t("goodsTotal")}
            </td>
            <td className="py-1 text-end">{money(ci.goodsTotalMinor)}</td>
          </tr>
          <tr>
            <td colSpan={6} className="py-1 text-end">
              {t("shipping")}
            </td>
            <td className="py-1 text-end">{money(ci.shippingMinor)}</td>
          </tr>
          <tr>
            <td colSpan={6} className="py-1 text-end">
              {t("insurance")}
            </td>
            <td className="py-1 text-end">{money(ci.insuranceMinor)}</td>
          </tr>
          <tr className="font-semibold">
            <td colSpan={6} className="py-1 text-end">
              {t("invoiceTotal")}
            </td>
            <td className="py-1 text-end">{money(ci.invoiceTotalMinor)}</td>
          </tr>
        </tfoot>
      </table>
      <section>
        <h2 className="font-semibold">{t("packages")}</h2>
        <ul>
          {ci.packages.map((p, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parcels have no id
            <li key={n}>
              {t("package", {
                n: n + 1,
                l: Math.ceil(p.lengthMm / 10),
                w: Math.ceil(p.widthMm / 10),
                h: Math.ceil(p.heightMm / 10),
                kg: (p.weightG / 1000).toFixed(2),
              })}
            </li>
          ))}
        </ul>
        <p>{t("grossWeight", { kg: (ci.grossWeightG / 1000).toFixed(2) })}</p>
      </section>
      <p>
        {t("exportDecl")}: {exportStatus}
      </p>
      {ci.euStatement ? <p data-testid="ci-eu">{ci.euStatement}</p> : null}
      <p>{ci.originStatement}</p>
      <p>{t("declaration")}</p>
      <div className="grid grid-cols-3 gap-6 pbs-8">
        <div className="border-t border-ink pbs-1">{t("signature")}</div>
        <div className="border-t border-ink pbs-1">
          {t("name")}: {ci.signatureName}
        </div>
        <div className="border-t border-ink pbs-1">{t("date")}</div>
      </div>
    </article>
  );
}
