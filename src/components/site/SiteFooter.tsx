import Image from "next/image";
import { useTranslations } from "next-intl";
import { CancelPurchaseLink } from "@/components/ui/CancelPurchaseLink";
import { Link } from "@/i18n/navigation";
import type { ArtworkImageDTO } from "@/lib/catalog";
import { cx } from "@/lib/cx";

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
 *
 * With `background` (the public site: "By the Lake", like the home page's quote band) the footer
 * is a dark band: the painting's lake, decorative and lazy, under an `ink/70` overlay that
 * keeps the light text above 4.5:1. Without it (checkout) it stays the plain light footer.
 */
export function SiteFooter({
  year,
  variant = "full",
  background = null,
}: {
  /** Defaults to the current year in Asia/Jerusalem. */
  year?: number;
  variant?: "full" | "minimal";
  background?: ArtworkImageDTO | null;
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
    <footer
      className={cx(
        "mbs-16 text-sm",
        background
          ? "relative isolate overflow-hidden bg-ink text-paper"
          : "border-t border-line bg-wall",
      )}
      data-testid="site-footer"
    >
      {background ? (
        <>
          <Image
            src={background.src}
            alt=""
            aria-hidden="true"
            fill
            sizes="100vw"
            quality={75}
            placeholder={background.blurDataUrl ? "blur" : "empty"}
            blurDataURL={background.blurDataUrl ?? undefined}
            className="-z-20 object-cover"
            style={{ objectPosition: "center 55%" }}
          />
          <div
            className="absolute inset-0 -z-10 bg-ink/70"
            aria-hidden="true"
          />
        </>
      ) : null}
      <div
        className={cx(
          "mx-auto flex max-w-6xl flex-col gap-4 px-4",
          background ? "py-12" : "py-8",
        )}
      >
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
        <p className={background ? "text-paper/85" : "text-ink-muted"}>
          {t("footer.merchantCountry")}
        </p>
        <p className={background ? "text-paper/85" : "text-ink-muted"}>
          {t("footer.copyright", { year: shownYear, name: t("meta.siteName") })}
        </p>
      </div>
    </footer>
  );
}
