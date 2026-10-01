import "server-only";
import { join } from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * react-pdf font registration (spec §2.3 `assets/fonts`, M1 spike (a) and (d)).
 *
 * - Static OFL TTFs only (react-pdf does not handle variable fonts): Assistant for body text,
 *   Frank Ruhl Libre for headings, both with Hebrew and Latin coverage.
 * - Paths are resolved from `process.cwd()`, which is the project root under `next start` and the
 *   function root on Vercel. `next.config.ts` traces `./assets/fonts/**` into every server route
 *   (`outputFileTracingIncludes`), so the files are present in the deployed output.
 * - Hyphenation is disabled: react-pdf's default English hyphenator splits Hebrew words.
 * - Hebrew text needs `direction: 'rtl'` in its style (see `rtlText`); without it react-pdf picks
 *   the base direction from the default (LTR) and a line that starts with a Latin token is laid
 *   out left to right. `direction` is honoured by react-pdf 4.9 but missing from its Style type.
 */
export const PDF_FONT_DIR = join(process.cwd(), "assets", "fonts");

export const PDF_FONT_FILES = {
  "Assistant-Regular": "Assistant-Regular.ttf",
  "Assistant-Bold": "Assistant-Bold.ttf",
  "FrankRuhlLibre-Regular": "FrankRuhlLibre-Regular.ttf",
  "FrankRuhlLibre-Bold": "FrankRuhlLibre-Bold.ttf",
} as const;

export const PDF_BODY_FONT = "Assistant";
export const PDF_HEADING_FONT = "FrankRuhlLibre";

let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  const file = (name: keyof typeof PDF_FONT_FILES) =>
    join(PDF_FONT_DIR, PDF_FONT_FILES[name]);
  Font.register({
    family: PDF_BODY_FONT,
    fonts: [
      { src: file("Assistant-Regular"), fontWeight: 400 },
      { src: file("Assistant-Bold"), fontWeight: 700 },
    ],
  });
  Font.register({
    family: PDF_HEADING_FONT,
    fonts: [
      { src: file("FrankRuhlLibre-Regular"), fontWeight: 400 },
      { src: file("FrankRuhlLibre-Bold"), fontWeight: 700 },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

/** Style fragment for right-to-left paragraphs (`direction` is untyped in @react-pdf/types). */
export function rtlText(rtl: boolean): { textAlign: "right" | "left" } {
  return (
    rtl ? { textAlign: "right", direction: "rtl" } : { textAlign: "left" }
  ) as { textAlign: "right" | "left" };
}
