import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DocumentSections } from "@/components/docs/DocumentSections";
import { LEGAL_TEXTS_APPROVED } from "@/content/legal/versions";
import { formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { getBuyerDisclosure } from "@/server/documents/buyer";
import { ipHashFrom } from "@/server/security/ip";
import { checkLimit } from "@/server/security/rate-limit";

/**
 * `/[locale]/print/disclosure/[number]?k=<token>` (spec §5.4): the s.14C(b) disclosure document as
 * printable HTML (A4). The same builder feeds the inline email summary. Buyer access by the order
 * token; a bad token is rate limited and 404s. The printed copy goes in the parcel or is handed over
 * at pickup (spec §5.4). A DRAFT note shows until the lawyer approves the texts.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function DisclosurePrintPage({
  params,
  searchParams,
}: PageProps<"/[locale]/print/disclosure/[number]">) {
  const { locale, number } = await params;
  if (!isLocale(locale)) notFound();
  const k = (await searchParams).k;
  const doc = await getBuyerDisclosure(
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
    namespace: "documents-compliance.disclosure",
  });
  return (
    <article className="flex flex-col gap-6" data-testid="disclosure-document">
      <header className="flex flex-col gap-1 border-b border-line pbe-4">
        <h1 className="text-2xl">{doc.title}</h1>
        <p className="text-sm text-ink-muted">
          {t("meta", {
            number: doc.orderNumber,
            date: formatDateTime(doc.issuedAt, locale),
            version: doc.version,
          })}
        </p>
        {LEGAL_TEXTS_APPROVED ? null : (
          <p className="text-sm text-hold" data-testid="disclosure-draft">
            {t("draft")}
          </p>
        )}
      </header>
      <DocumentSections sections={doc.sections} />
      <footer className="border-t border-line pbs-4 text-sm text-ink-muted">
        {t("printNote")}
      </footer>
    </article>
  );
}
