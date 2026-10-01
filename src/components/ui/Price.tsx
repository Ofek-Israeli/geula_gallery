import { type Currency, formatMoney, type MoneyLocale } from "@/lib/money";
import { Bdi } from "./Bdi";

/** A price in minor units, isolated LTR and never mirrored (spec §6.4, §6.5). */
export function Price({
  amountMinor,
  currency,
  locale,
  className,
}: {
  amountMinor: number;
  currency: Currency;
  locale: MoneyLocale;
  className?: string;
}) {
  return (
    <Bdi className={className}>
      {formatMoney(amountMinor, currency, locale)}
    </Bdi>
  );
}
