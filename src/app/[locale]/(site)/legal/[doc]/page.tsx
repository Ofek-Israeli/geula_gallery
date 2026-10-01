import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CancelPurchaseLink } from "@/components/ui/CancelPurchaseLink";
import { LEGAL_DOCUMENTS, toLegalProfile } from "@/content/legal";
import { LEGAL_TEXTS_APPROVED, LEGAL_VERSIONS } from "@/content/legal/versions";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { isLocale, type Locale } from "@/lib/locale";
import { isLegalDoc, LEGAL_DOCS, localePath, paths } from "@/lib/routes";
import { getSetting } from "@/server/settings";

/**
 * `/[locale]/legal/[doc]` (spec §6.2): terms, returns, shipping, privacy, accessibility. TSX drafts
 * filled from the business profile through `toLegalProfile` (never the ID number), with a DRAFT
 * banner until `LEGAL_TEXTS_APPROVED`.
 */
const VERSION_DATE = new Date("2026-10-01T09:00:00Z");

function versionOf(doc: string): string {
  if (doc === "terms") return LEGAL_VERSIONS.terms;
  if (doc === "returns") return LEGAL_VERSIONS.returns;
  if (doc === "privacy") return LEGAL_VERSIONS.privacy;
  return LEGAL_VERSIONS.terms;
}

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/legal/[doc]">): Promise<Metadata> {
  const { locale, doc } = await params;
  if (!isLocale(locale) || !isLegalDoc(doc)) return {};
  const t = await getTranslations({ locale, namespace: "legal" });
  return {
    title: LEGAL_DOCUMENTS[locale][doc].title,
    description: t(`descriptions.${doc}`),
    alternates: {
      canonical: localePath(locale, paths.legal(doc)),
      languages: {
        he: localePath("he", paths.legal(doc)),
        en: localePath("en", paths.legal(doc)),
        "x-default": localePath("he", paths.legal(doc)),
      },
    },
  };
}

export default async function LegalPage({
  params,
}: PageProps<"/[locale]/legal/[doc]">) {
  const { locale, doc } = await params;
  if (!isLocale(locale) || !isLegalDoc(doc)) notFound();
  const [t, profile] = await Promise.all([
    getTranslations({ locale, namespace: "legal" }),
    getSetting("business_profile"),
  ]);
  const mod = LEGAL_DOCUMENTS[locale][doc];
  const l = (p: string) => localePath(locale as Locale, p);
  const Body = mod.Body;
  return (
    <article className="flex max-w-3xl flex-col gap-4" data-testid="legal-page">
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl">{mod.title}</h1>
        {LEGAL_TEXTS_APPROVED ? null : (
          <p
            role="note"
            className="w-fit rounded-sm border border-hold px-2 py-1 text-sm text-hold"
            data-testid="draft-banner"
          >
            {t("draftBanner")}
          </p>
        )}
        <p className="text-sm text-ink-muted">
          {t("version", {
            version: versionOf(doc),
            date: formatDate(VERSION_DATE, locale),
          })}
        </p>
      </header>
      <Body
        profile={toLegalProfile(profile, locale)}
        links={{
          terms: l(paths.legal("terms")),
          returns: l(paths.legal("returns")),
          shipping: l(paths.legal("shipping")),
          privacy: l(paths.legal("privacy")),
          accessibility: l(paths.legal("accessibility")),
          cancel: l(paths.cancel()),
        }}
        versionDate={formatDate(VERSION_DATE, locale)}
      />
      <p className="mbs-6 font-medium">
        <CancelPurchaseLink />
      </p>
      <nav aria-label={t("related")} className="border-t border-line pbs-4">
        <h2 className="text-lg">{t("related")}</h2>
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {LEGAL_DOCS.filter((d) => d !== doc).map((d) => (
            <li key={d}>
              <Link href={paths.legal(d)} className="underline">
                {LEGAL_DOCUMENTS[locale][d].title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </article>
  );
}
