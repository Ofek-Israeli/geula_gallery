import type { Metadata } from "next";
import { SaleBanner } from "@/components/site/SaleBanner";
import { SiteAnalytics } from "@/components/site/SiteAnalytics";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/ui/SkipLink";
import { isLocale } from "@/lib/locale";
import { activeSale } from "@/lib/sale";
import { cartCount } from "@/server/cart/cart";
import { getHeroArtwork } from "@/server/catalog/queries";
import { env } from "@/server/env";
import { readCartIds } from "@/server/next/cart";
import { getSettingOrNull } from "@/server/settings";

/**
 * Google Search Console's "HTML tag" verification (`GOOGLE_SITE_VERIFICATION`). Search Console
 * follows the home page's redirect to the default locale, so the public pages carry it.
 */
export const metadata: Metadata = env.GOOGLE_SITE_VERIFICATION
  ? { verification: { google: env.GOOGLE_SITE_VERIFICATION } }
  : {};

/**
 * Public site chrome: skip link, the sale strip while a site-wide sale runs, header (with the cart
 * count; no cart while online sales are closed) and footer (with the cancellation link, spec §1.2, over "By the Lake" like the home
 * page's quote band).
 */
export default async function SiteLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  const lang = isLocale(locale) ? locale : "he";
  const [count, hero, checkout] = await Promise.all([
    env.SALES_OPEN ? readCartIds().then((ids) => cartCount(ids)) : 0,
    getHeroArtwork(lang),
    getSettingOrNull("checkout"),
  ]);
  const sale = activeSale(checkout?.sale);
  return (
    <>
      <SkipLink />
      {sale ? <SaleBanner sale={sale} locale={lang} /> : null}
      <SiteHeader cartCount={count} />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none"
      >
        {children}
      </main>
      <SiteFooter background={hero?.image ?? null} />
      {env.VERCEL ? <SiteAnalytics /> : null}
    </>
  );
}
