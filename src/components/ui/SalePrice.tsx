import { useTranslations } from "next-intl";
import type { Currency, MoneyLocale } from "@/lib/money";
import { Price } from "./Price";

/**
 * A price during the site-wide sale (`src/lib/sale.ts`): the list price crossed out, the sale price
 * and the percentage off. Without a list price (no sale) it is a plain `Price`.
 */
export function SalePrice({
  amountMinor,
  wasMinor,
  currency,
  locale,
  className,
}: {
  amountMinor: number;
  /** The list price while a sale runs; null otherwise. */
  wasMinor: number | null;
  currency: Currency;
  locale: MoneyLocale;
  className?: string;
}) {
  const t = useTranslations("artwork.buy");
  if (wasMinor === null || wasMinor <= amountMinor) {
    return (
      <Price
        amountMinor={amountMinor}
        currency={currency}
        locale={locale}
        className={className}
      />
    );
  }
  const percent = Math.round((1 - amountMinor / wasMinor) * 100);
  return (
    <span
      className={`inline-flex flex-wrap items-baseline gap-x-2 ${className ?? ""}`}
      data-testid="sale-price"
    >
      <span className="sr-only">{t("wasPrice")}</span>
      <del className="text-[0.8em] font-normal text-ink-muted">
        <Price amountMinor={wasMinor} currency={currency} locale={locale} />
      </del>
      <span className="sr-only">{t("nowPrice")}</span>
      <Price amountMinor={amountMinor} currency={currency} locale={locale} />
      <bdi dir="ltr" className="text-[0.7em] font-semibold text-reddot">
        {t("percentOff", { percent })}
      </bdi>
    </span>
  );
}
