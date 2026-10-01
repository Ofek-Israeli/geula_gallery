import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import QRCode from "qrcode";
import { formatDimensions } from "@/lib/dimensions";
import { formatDate } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { getCoaData } from "@/server/documents/coa";
import { requireAdmin } from "@/server/next/guards";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * `/[locale]/print/admin/coa/[saleId]` (spec §5.4, Tier B): the bilingual-ready certificate of
 * authenticity (A4) with a QR code to the work's page, the copyright (s.37(c)) and moral-rights
 * (s.45(b)) notes and a signature line. Demo works are stamped.
 */
export default async function CoaPage({
  params,
}: PageProps<"/[locale]/print/admin/coa/[saleId]">) {
  const { locale, saleId } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  if (!/^[0-9a-f-]{36}$/i.test(saleId)) notFound();
  const d = await getCoaData(ctx, saleId, locale);
  if (!d) notFound();
  const t = await getTranslations({
    locale,
    namespace: "documents-compliance.coa",
  });
  const dims = formatDimensions(
    { heightMm: d.heightMm, widthMm: d.widthMm, depthMm: d.depthMm },
    locale,
  );
  const qr = await QRCode.toDataURL(d.artworkUrl, { margin: 1, width: 240 });
  return (
    <article
      className="flex min-h-[250mm] flex-col gap-6 border-double border-8 border-ink p-10"
      data-testid="coa"
    >
      {d.isDemo || d.isMock ? (
        <p className="border-2 border-reddot p-2 text-center font-semibold text-reddot">
          {t("demo")}
        </p>
      ) : null}
      <h1 className="text-center text-4xl">{t("title")}</h1>
      <p className="text-center">{t("intro")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-lg">
        <dt className="text-ink-muted">{t("work")}</dt>
        <dd>{d.title}</dd>
        <dt className="text-ink-muted">{t("inventory")}</dt>
        <dd>
          <bdi dir="ltr">{d.inventoryNumber}</bdi>
        </dd>
        {d.yearCreated ? (
          <>
            <dt className="text-ink-muted">{t("year")}</dt>
            <dd>{d.yearCreated}</dd>
          </>
        ) : null}
        {d.mediumText ? (
          <>
            <dt className="text-ink-muted">{t("medium")}</dt>
            <dd>{d.mediumText}</dd>
          </>
        ) : null}
        <dt className="text-ink-muted">{t("dimensions")}</dt>
        <dd>
          <bdi dir="ltr">{dims.cm} cm</bdi> (<bdi dir="ltr">{dims.inches}</bdi>)
        </dd>
        <dt className="text-ink-muted">{t("signed")}</dt>
        <dd>{d.signed ? t("yes") : t("no")}</dd>
        <dt className="text-ink-muted">{t("date")}</dt>
        <dd>{formatDate(d.soldAt, locale)}</dd>
        {d.buyerName ? (
          <>
            <dt className="text-ink-muted">{t("buyer")}</dt>
            <dd>{d.buyerName}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm">{t("copyright")}</p>
      <div className="mbs-auto flex items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <div className="h-16 w-72 border-b border-ink" />
          <p>
            {t("signature")}: {d.signatureName || d.artistName}
          </p>
        </div>
        <figure className="flex flex-col items-center gap-1">
          {/* biome-ignore lint/performance/noImgElement: a data: URL QR code for print */}
          <img src={qr} alt={d.artworkUrl} width={120} height={120} />
          <figcaption className="text-xs text-ink-muted">
            {t("verify")}
          </figcaption>
        </figure>
      </div>
    </article>
  );
}
