import { getTranslations } from "next-intl/server";
import { type AppLocale, dirOf, LOCALES } from "@/i18n/routing";

/**
 * Site-wide bilingual demo banner (spec §6.9). Rendered by the root layout only when
 * `DEMO_MODE=true`; the current locale's sentence comes first.
 */
export async function DemoBanner({ locale }: { locale: AppLocale }) {
  const order = [locale, ...LOCALES.filter((l) => l !== locale)];
  const texts = await Promise.all(
    order.map(async (l) => {
      const t = await getTranslations({ locale: l, namespace: "common.demo" });
      return { locale: l, text: t("banner") };
    }),
  );
  return (
    <aside
      aria-label={texts[0]?.text}
      className="border-b border-hold bg-wall px-4 py-2 text-center text-sm text-ink print:hidden"
    >
      {texts.map(({ locale: l, text }, i) => (
        <span key={l} lang={l} dir={dirOf(l)}>
          {i > 0 ? " / " : null}
          {text}
        </span>
      ))}
    </aside>
  );
}
