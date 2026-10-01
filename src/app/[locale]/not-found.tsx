import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";

/** Localized 404 for `notFound()` inside `[locale]` (spec §6.4). Unmatched URLs use global-not-found. */
export default async function LocaleNotFound() {
  const t = await getTranslations("common.notFound");
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-16"
    >
      <h1 className="text-4xl">{t("title")}</h1>
      <p className="text-ink-muted">{t("body")}</p>
      <p>
        <Link href="/" className={buttonClasses("secondary")}>
          {t("home")}
        </Link>
      </p>
    </main>
  );
}
