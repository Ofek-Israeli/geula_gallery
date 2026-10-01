import "./globals.css";
import type { Metadata } from "next";
import en from "../../messages/en/common.json";
import he from "../../messages/he/common.json";
import { fontVariables } from "./fonts";

/**
 * Global 404 for URLs that match no route (spec §6.4; `experimental.globalNotFound`). It bypasses
 * the `[locale]` root layout, so it renders a full document and is bilingual (Hebrew first).
 */
export const metadata: Metadata = {
  title: `404 · ${he.meta.siteName} · ${en.meta.siteName}`,
  robots: { index: false, follow: false },
};

export default function GlobalNotFound() {
  return (
    <html lang="he" dir="rtl" className={fontVariables}>
      <body className="bg-paper text-ink antialiased">
        <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-10 px-4 py-16">
          <section className="flex flex-col gap-3">
            <h1 className="text-4xl">{he.notFound.title}</h1>
            <p className="text-ink-muted">{he.notFound.body}</p>
            <p>
              <a href="/he" className="underline">
                {he.notFound.home}
              </a>
            </p>
          </section>
          <section lang="en" dir="ltr" className="flex flex-col gap-3">
            <h2 className="text-3xl">{en.notFound.title}</h2>
            <p className="text-ink-muted">{en.notFound.body}</p>
            <p>
              <a href="/en" className="underline">
                {en.notFound.home}
              </a>
            </p>
          </section>
        </main>
      </body>
    </html>
  );
}
