"use client";

import { useTranslations } from "next-intl";
import { buttonClasses } from "@/components/ui/Button";

/** Error boundary for the locale tree. Never shows error details to visitors. */
export default function LocaleError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("common.error");
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-16"
    >
      <h1 className="text-4xl">{t("title")}</h1>
      <p className="text-ink-muted">{t("body")}</p>
      <p>
        <button
          type="button"
          className={buttonClasses("secondary")}
          onClick={() => retry()}
        >
          {t("retry")}
        </button>
      </p>
    </main>
  );
}
