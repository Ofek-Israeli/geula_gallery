import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/ui/SkipLink";

/** Public site chrome: skip link, header and footer, both with the cancellation link (spec §1.2). */
export default function SiteLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <>
      <SkipLink />
      <SiteHeader />
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
