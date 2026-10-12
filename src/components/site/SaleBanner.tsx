import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import type { ActiveSale } from "@/lib/sale";

/**
 * The strip above the header while a site-wide sale runs (`src/lib/sale.ts`): its label in the
 * page's language and its last day, linking to the works. Public pages only.
 */
export function SaleBanner({
  sale,
  locale,
}: {
  sale: ActiveSale;
  locale: Locale;
}) {
  const t = useTranslations("common.sale");
  const until = sale.endsOn
    ? new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-GB", {
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(`${sale.endsOn}T00:00:00Z`))
    : null;
  return (
    <aside
      aria-label={sale.label[locale]}
      className="bg-ink px-4 py-2 text-center text-sm text-paper print:hidden"
      data-testid="sale-banner"
    >
      <Link href={paths.works()} className="text-paper no-underline">
        <span className="font-semibold">{sale.label[locale]}</span>
        {until ? (
          <span className="opacity-80"> · {t("until", { date: until })}</span>
        ) : null}
      </Link>
    </aside>
  );
}
