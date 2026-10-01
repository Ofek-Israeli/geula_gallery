import type { Metadata } from "next";

/**
 * Printables (buyer documents behind `?k=`, admin documents behind requireAdmin). No site chrome;
 * noindex; `Referrer-Policy: no-referrer` comes from next.config.ts.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PrintLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-[210mm] flex-1 bg-white px-6 py-8 print:max-w-none print:p-0"
    >
      {children}
    </main>
  );
}
