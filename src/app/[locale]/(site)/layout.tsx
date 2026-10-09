import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/ui/SkipLink";
import { isLocale } from "@/lib/locale";
import { cartCount } from "@/server/cart/cart";
import { getHeroArtwork } from "@/server/catalog/queries";
import { readCartIds } from "@/server/next/cart";

/**
 * Public site chrome: skip link, header (with the cart count) and footer (with the cancellation
 * link, spec §1.2, over "By the Lake" like the home page's quote band).
 */
export default async function SiteLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  const [count, hero] = await Promise.all([
    readCartIds().then((ids) => cartCount(ids)),
    getHeroArtwork(isLocale(locale) ? locale : "he"),
  ]);
  return (
    <>
      <SkipLink />
      <SiteHeader cartCount={count} />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none"
      >
        {children}
      </main>
      <SiteFooter background={hero?.image ?? null} />
    </>
  );
}
