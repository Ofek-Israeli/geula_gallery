import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PrivacyNotice } from "@/components/ui/PrivacyNotice";
import { Link } from "@/i18n/navigation";
import { countryOptions } from "@/lib/countries";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { getArtworkPage } from "@/server/catalog/queries";
import { issueFormStartToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { submitRequestAction } from "./actions";
import { RequestForm } from "./RequestForm";

type Kind = "question" | "quote" | "offer";

function kindOf(v: string | string[] | undefined): Kind {
  const k = Array.isArray(v) ? v[0] : v;
  return k === "quote" || k === "offer" ? k : "question";
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<"/[locale]/works/[slug]/request">): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const kind = kindOf((await searchParams).kind);
  const data = await getArtworkPage(locale, slug);
  const t = await getTranslations({ locale, namespace: "requests" });
  return {
    title: t(`meta.${kind}`, { title: data?.artwork.title ?? slug }),
    robots: { index: false, follow: true },
  };
}

/**
 * `/[locale]/works/[slug]/request?kind=question|quote` (spec §5.8): ask about a work or request a
 * quote (quote-only works and blocked shipping results such as SIZE_QUOTE / VALUE_CAP /
 * GB_LOW_VALUE / ZONE_DISABLED), or make an offer (Tier B) on works that accept offers.
 */
export default async function RequestPage({
  params,
  searchParams,
}: PageProps<"/[locale]/works/[slug]/request">) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const data = await getArtworkPage(locale, slug);
  if (!data) notFound();
  const { artwork } = data;
  const requested = kindOf(sp.kind);
  // A quote needs an available work, an offer one that accepts offers; else a question.
  const available = artwork.state.kind === "available";
  const kind: Kind =
    requested === "quote" && available
      ? "quote"
      : requested === "offer" && available && artwork.offersEnabled
        ? "offer"
        : "question";
  const t = await getTranslations({ locale, namespace: "requests" });
  const shipping = await getSetting("shipping");
  const to = Array.isArray(sp.to) ? sp.to[0] : sp.to;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <Link href={paths.artwork(slug)} className="text-sm">
        {t("backToArtwork")}
      </Link>
      <header className="flex items-center gap-4">
        {artwork.image ? (
          // biome-ignore lint/performance/noImgElement: small thumbnail of the work
          <img
            src={artwork.image.src}
            alt=""
            width={96}
            height={96}
            className="size-24 object-contain"
          />
        ) : null}
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl">{t(`title.${kind}`)}</h1>
          <p className="text-xl">{artwork.title}</p>
        </div>
      </header>
      <p>{t(`intro.${kind}`)}</p>
      <RequestForm
        action={submitRequestAction}
        locale={locale}
        kind={kind}
        slug={slug}
        formStart={issueFormStartToken()}
        countries={countryOptions(locale, shipping.deniedCountries)}
        defaultCountry={to && /^[A-Z]{2}$/.test(to) ? to : "IL"}
      />
      <PrivacyNotice>{t("privacy")}</PrivacyNotice>
    </div>
  );
}
