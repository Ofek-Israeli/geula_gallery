import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { paths } from "@/lib/routes";

/**
 * The strip above the header while the checkout is a preview (`CHECKOUT_PREVIEW`): online payment
 * is not active yet, so trying the checkout places no order and charges nothing. Public and
 * checkout pages.
 */
export function PreviewBanner() {
  const t = useTranslations("common.preview");
  return (
    <aside
      aria-label={t("label")}
      className="border-b border-hold bg-wall px-4 py-2 text-center text-sm print:hidden"
      data-testid="preview-banner"
    >
      {t("banner")}{" "}
      <Link href={paths.contact()} className="underline">
        {t("buyNow")}
      </Link>
    </aside>
  );
}
