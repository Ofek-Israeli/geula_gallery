import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";

/**
 * Home placeholder (M1). M2 adds the minimal storefront and WS1 the full home (§6.2): featured
 * work as LCP, available works, series, about snippet, commissions CTA, Organization JSON-LD.
 */
export default async function HomePage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = await getTranslations({ locale, namespace: "common.home" });
  return (
    <div className="flex flex-col gap-6 py-12">
      <h1 className="text-5xl">{t("title")}</h1>
      <p className="max-w-prose text-lg text-ink-muted">{t("intro")}</p>
      <p>
        <Link href="/works" className={buttonClasses("secondary")}>
          {t("viewWorks")}
        </Link>
      </p>
    </div>
  );
}
