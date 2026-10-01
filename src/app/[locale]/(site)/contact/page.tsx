import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ContactDetails } from "@/components/site/ContactDetails";
import { JsonLd } from "@/components/site/JsonLd";
import { pageMetadata } from "@/components/site/metadata";
import { personJsonLd } from "@/components/site/structured-data";
import { CancelPurchaseLink } from "@/components/ui/CancelPurchaseLink";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { getPublicProfile } from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * `/contact` (spec §6.2): general questions and commissions (`?topic=commission` puts the
 * commission section first), email and phone isolated LTR, the cancellation route, and the Person
 * JSON-LD.
 *
 * The on-site contact form (spec §5.8: `buyer_requests` with topic GENERAL / COMMISSION, s.11
 * notice, honeypot, 5/h/IP, `request-ack` + `painter-new-request`) needs WS4's
 * `server/requests/service.ts#submitRequest`, which lands after WS1 in the M4 rebase order; it is
 * wired in M4 (see docs/architecture.md "M3 storefront notes").
 */
function topicOf(v: string | string[] | undefined): "general" | "commission" {
  return (Array.isArray(v) ? v[0] : v) === "commission"
    ? "commission"
    : "general";
}

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/contact">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "catalog.contact" });
  return pageMetadata({
    locale,
    path: paths.contact(),
    title: t("title"),
    description: t("metaDescription"),
  });
}

export default async function ContactPage({
  params,
  searchParams,
}: PageProps<"/[locale]/contact">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const topic = topicOf((await searchParams).topic);
  const [t, ta, profile] = await Promise.all([
    getTranslations({ locale, namespace: "catalog.contact" }),
    getTranslations({ locale, namespace: "catalog.about" }),
    getPublicProfile(locale),
  ]);
  const sections = [
    {
      id: "general",
      title: t("generalTitle"),
      body: t("generalBody"),
      subject: t("subjectGeneral"),
      extra: t("workQuestion"),
    },
    {
      id: "commission",
      title: t("commissionTitle"),
      body: t("commissionBody"),
      subject: t("subjectCommission"),
      extra: null,
    },
  ];
  if (topic === "commission") sections.reverse();

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <JsonLd
        data={personJsonLd({
          base: env.APP_URL,
          locale,
          name: profile.artistName,
          jobTitle: ta("jobTitle"),
          email: profile.email,
        })}
      />
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl">{t("title")}</h1>
        <p className="max-w-prose text-lg">{t("intro")}</p>
      </header>
      {sections.map((s) => (
        <section
          key={s.id}
          id={s.id}
          aria-labelledby={`${s.id}-title`}
          className="flex flex-col gap-3 border-t border-line pt-6"
        >
          <h2 id={`${s.id}-title`} className="text-2xl">
            {s.title}
          </h2>
          <p className="max-w-prose">{s.body}</p>
          <ContactDetails
            email={profile.email}
            phoneIntl={profile.phoneIntl}
            phoneLocal={profile.phoneLocal}
            subject={s.subject}
            locale={locale}
          />
          {s.extra ? (
            <p className="max-w-prose text-sm text-ink-muted">{s.extra}</p>
          ) : null}
        </section>
      ))}
      <section
        aria-labelledby="cancel-title"
        className="flex flex-col gap-2 border-t border-line pt-6"
      >
        <h2 id="cancel-title" className="text-2xl">
          {t("cancelTitle")}
        </h2>
        <p className="max-w-prose">{t("cancelBody")}</p>
        <p>
          <CancelPurchaseLink />
        </p>
      </section>
    </div>
  );
}
