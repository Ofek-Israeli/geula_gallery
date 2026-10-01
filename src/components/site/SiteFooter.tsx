import { useTranslations } from "next-intl";
import { CancelPurchaseLink } from "@/components/ui/CancelPurchaseLink";
import { Link } from "@/i18n/navigation";

const LEGAL_DOCS = [
  "terms",
  "returns",
  "shipping",
  "privacy",
  "accessibility",
] as const;

/**
 * Public footer with the cancellation link and the legal pages (spec §1.2, §6.2). Never shows the
 * seller's ID number (spec §1.2 Compliance). `variant="minimal"` is the checkout footer.
 */
export function SiteFooter({
  year,
  variant = "full",
}: {
  /** Defaults to the current year in Asia/Jerusalem. */
  year?: number;
  variant?: "full" | "minimal";
}) {
  const t = useTranslations("common");
  const shownYear =
    year ??
    Number(
      new Intl.DateTimeFormat("en", {
        timeZone: "Asia/Jerusalem",
        year: "numeric",
      }).format(new Date()),
    );
  return (
    <footer className="mbs-16 border-t border-line bg-wall text-sm">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8">
        <p className="text-base font-medium">
          <CancelPurchaseLink />
        </p>
        {variant === "full" ? (
          <nav aria-label={t("footer.legalLabel")}>
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {LEGAL_DOCS.map((doc) => (
                <li key={doc}>
                  <Link
                    href={`/legal/${doc}`}
                    className="inline-flex min-h-6 items-center underline"
                  >
                    {t(`footer.${doc}`)}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/credits"
                  className="inline-flex min-h-6 items-center underline"
                >
                  {t("footer.credits")}
                </Link>
              </li>
            </ul>
          </nav>
        ) : (
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            <li>
              <Link href="/legal/terms" className="underline">
                {t("footer.terms")}
              </Link>
            </li>
            <li>
              <Link href="/legal/privacy" className="underline">
                {t("footer.privacy")}
              </Link>
            </li>
          </ul>
        )}
        <p className="text-ink-muted">{t("footer.merchantCountry")}</p>
        <p className="text-ink-muted">
          {t("footer.copyright", { year: shownYear, name: t("meta.siteName") })}
        </p>
      </div>
    </footer>
  );
}
