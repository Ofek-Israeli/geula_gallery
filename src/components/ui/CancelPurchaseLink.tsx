import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cx } from "@/lib/cx";

/**
 * "ביטול עסקה / Cancel a purchase" (spec §1.2 Tier A): in the header and footer of every public
 * page and in the checkout footer. Prefills the order number when one is known.
 */
export function CancelPurchaseLink({
  orderNumber,
  className,
}: {
  orderNumber?: string;
  className?: string;
}) {
  const t = useTranslations("common");
  return (
    <Link
      href={
        orderNumber
          ? { pathname: "/cancel", query: { order: orderNumber } }
          : "/cancel"
      }
      className={cx("inline-flex min-h-6 items-center underline", className)}
    >
      {t("cancelPurchase")}
    </Link>
  );
}
