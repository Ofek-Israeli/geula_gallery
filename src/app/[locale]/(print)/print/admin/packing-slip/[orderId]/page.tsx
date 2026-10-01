import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { formatDimensions } from "@/lib/dimensions";
import { formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { requireAdmin } from "@/server/next/guards";
import { getPackingSlip } from "@/server/shipping/documents";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/[locale]/print/admin/packing-slip/[orderId]` (spec §5.4 "Printables", A4): who and where, what
 * is inside, the parcels, and the inserts the parcel must carry (the printed disclosure always).
 * requireAdmin here AND in the print/admin layout (spec §1.1.7).
 */
export default async function PackingSlipPage({
  params,
}: PageProps<"/[locale]/print/admin/packing-slip/[orderId]">) {
  const { locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const slip = await getPackingSlip(ctx, orderId, locale);
  if (!slip) notFound();
  const t = await getTranslations({
    locale,
    namespace: "documents-shipping.packingSlip",
  });
  const ts = await getTranslations({ locale, namespace: "shipping" });
  return (
    <article className="flex flex-col gap-6" data-testid="packing-slip">
      <header className="flex flex-col gap-1 border-b border-line pbe-4">
        <h1 className="text-2xl">{t("title")}</h1>
        <p className="text-lg">
          {t("order", { number: "" })}
          <bdi dir="ltr">{slip.orderNumber}</bdi>
        </p>
        <p className="text-sm text-ink-muted">
          {t("printed", { date: formatDateTime(slip.createdAt, locale) })}
        </p>
      </header>
      <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
        <section>
          <h2 className="font-semibold">{t("from")}</h2>
          <p>{slip.from.name}</p>
          {slip.from.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          {slip.from.phone ? (
            <p>
              <bdi dir="ltr">{slip.from.phone}</bdi>
            </p>
          ) : null}
        </section>
        <section>
          <h2 className="font-semibold">{t("to")}</h2>
          <address className="not-italic" dir="auto">
            <span className="block">{slip.to.name}</span>
            {slip.to.company ? (
              <span className="block">{slip.to.company}</span>
            ) : null}
            {slip.to.lines.map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))}
            {slip.to.phone ? (
              <bdi dir="ltr" className="block">
                {slip.to.phone}
              </bdi>
            ) : null}
          </address>
        </section>
      </div>
      <section className="flex flex-col gap-1">
        <p>
          {t("method")}: {ts(`method.${slip.method}` as never)}
          {slip.carrierName ? ` · ${slip.carrierName}` : ""}
        </p>
        {slip.trackingNumber ? (
          <p>
            {t("tracking")}: <bdi dir="ltr">{slip.trackingNumber}</bdi>
          </p>
        ) : null}
      </section>
      <section>
        <h2 className="font-semibold">{t("items")}</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-start">
              <th className="py-1 text-start">{t("items")}</th>
              <th className="py-1 text-start">{t("inventory")}</th>
              <th className="py-1 text-start">{t("dimensions")}</th>
              <th className="py-1 text-start">{t("packaging")}</th>
            </tr>
          </thead>
          <tbody>
            {slip.items.map((i) => {
              const d = formatDimensions(
                {
                  heightMm: i.heightMm,
                  widthMm: i.widthMm,
                  depthMm: i.depthMm,
                },
                locale,
              );
              return (
                <tr key={i.inventoryNumber} className="border-b border-line">
                  <td className="py-1">{i.title}</td>
                  <td className="py-1">
                    <bdi dir="ltr">{i.inventoryNumber}</bdi>
                  </td>
                  <td className="py-1">
                    <bdi dir="ltr">{d.cm}</bdi>
                  </td>
                  <td className="py-1">
                    {ts(`packaging.${i.packagingType}` as never)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h2 className="font-semibold">{t("parcels")}</h2>
        {slip.packages.length === 0 ? (
          <p>{t("notPacked")}</p>
        ) : (
          <ul>
            {slip.packages.map((p, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parcels have no id
              <li key={n}>
                {t("parcel", {
                  n: n + 1,
                  l: Math.ceil(p.lengthMm / 10),
                  w: Math.ceil(p.widthMm / 10),
                  h: Math.ceil(p.heightMm / 10),
                  kg: (p.weightG / 1000).toFixed(1),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="border border-ink p-3">
        <h2 className="font-semibold">{t("inside")}</h2>
        <ul className="list-disc ps-6">
          <li data-testid="insert-disclosure">{t("insertDisclosure")}</li>
          {slip.inserts.coa ? <li>{t("insertCoa")}</li> : null}
          {slip.inserts.receipt ? <li>{t("insertReceipt")}</li> : null}
        </ul>
      </section>
      <p className="text-lg font-semibold">{t("handling")}</p>
      {slip.checklistSavedAt ? (
        <p className="text-sm text-ink-muted">
          {t("checklist", {
            date: formatDateTime(slip.checklistSavedAt, locale),
          })}
        </p>
      ) : null}
    </article>
  );
}
