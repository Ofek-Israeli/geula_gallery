import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { cx } from "@/lib/cx";

/**
 * Privacy Protection Law s.11 notice shown at every form that collects personal data
 * (spec §7 Privacy). `children` states the purpose, whether supplying the data is a legal duty,
 * and who receives it; the final text needs the lawyer's review (WS6).
 */
export function PrivacyNotice({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const t = useTranslations("common.privacy");
  return (
    <aside
      className={cx(
        "rounded-sm border border-line bg-wall p-3 text-sm text-ink-muted",
        className,
      )}
    >
      <h2 className="font-sans text-sm font-semibold text-ink">{t("title")}</h2>
      <div className="mbs-1">{children}</div>
      <Link href="/legal/privacy" className="mbs-1 inline-block underline">
        {t("policyLink")}
      </Link>
    </aside>
  );
}
