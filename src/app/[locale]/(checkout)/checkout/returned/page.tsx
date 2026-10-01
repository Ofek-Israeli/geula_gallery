import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";

/**
 * `/[locale]/checkout/returned` (spec §5.2 "Return route"): where a return link with a bad or
 * missing token lands. It reveals nothing about any order.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function CheckoutReturnedPage({
  params,
}: PageProps<"/[locale]/checkout/returned">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = await getTranslations({ locale, namespace: "checkout.returned" });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl">{t("title")}</h1>
      <p className="max-w-prose">{t("body")}</p>
      <p>
        <Link href={paths.works()} className={buttonClasses("secondary")}>
          {t("works")}
        </Link>
      </p>
    </div>
  );
}
