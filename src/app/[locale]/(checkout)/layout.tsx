import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/ui/SkipLink";

/** Checkout and mock-pay: minimal chrome, cancellation link in header and footer, noindex (§2.1). */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <>
      <SkipLink />
      <SiteHeader variant="minimal" />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 focus:outline-none"
      >
        {children}
      </main>
      <SiteFooter variant="minimal" />
    </>
  );
}
