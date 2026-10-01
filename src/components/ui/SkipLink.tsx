import { useTranslations } from "next-intl";

export const MAIN_CONTENT_ID = "main";

/** "דילוג לתוכן" / "Skip to content" (spec §6.7). The target is `<main id="main" tabIndex={-1}>`. */
export function SkipLink({
  targetId = MAIN_CONTENT_ID,
}: {
  targetId?: string;
}) {
  const t = useTranslations("common");
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:inset-s-2 focus:top-2 focus:z-50 focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
    >
      {t("skipLink")}
    </a>
  );
}
