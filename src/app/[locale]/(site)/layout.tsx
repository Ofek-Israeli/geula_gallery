import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/ui/SkipLink";
import { cartCount } from "@/server/cart/cart";
import { readCartIds } from "@/server/next/cart";

/**
 * Public site chrome: skip link, header (with the cart count) and footer, both with the
 * cancellation link (spec §1.2).
 */
export default async function SiteLayout({
  children,
}: LayoutProps<"/[locale]">) {
  const count = await cartCount(await readCartIds());
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
      <SiteFooter />
    </>
  );
}
