import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { CancelPurchaseLink } from "@/components/ui/CancelPurchaseLink";
import { Link } from "@/i18n/navigation";
import { LanguageSwitch } from "./LanguageSwitch";

const linkClass =
  "inline-flex min-h-11 items-center no-underline hover:underline";

/**
 * Public header. `variant="minimal"` is the checkout chrome (no navigation), which still carries
 * the cancellation link (spec §1.2).
 */
export function SiteHeader({
  variant = "full",
}: {
  variant?: "full" | "minimal";
}) {
  const t = useTranslations("common");
  return (
    <header className="border-b border-line bg-paper">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="font-serif text-2xl no-underline">
          {t("meta.siteName")}
        </Link>
        <nav aria-label={t("nav.label")}>
          <ul className="flex flex-wrap items-center gap-x-5">
            {variant === "full" ? (
              <>
                <li>
                  <Link href="/works" className={linkClass}>
                    {t("nav.works")}
                  </Link>
                </li>
                <li>
                  <Link href="/about" className={linkClass}>
                    {t("nav.about")}
                  </Link>
                </li>
                <li>
                  <Link href="/contact" className={linkClass}>
                    {t("nav.contact")}
                  </Link>
                </li>
              </>
            ) : null}
            <li>
              <CancelPurchaseLink className="min-h-11" />
            </li>
            <li>
              <Suspense fallback={null}>
                <LanguageSwitch className={linkClass} />
              </Suspense>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
