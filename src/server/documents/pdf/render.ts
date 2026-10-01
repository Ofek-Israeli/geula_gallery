import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import type { DisclosureDoc } from "@/content/disclosure";
import { DisclosurePdf } from "./disclosure";
import { registerPdfFonts } from "./fonts";

/**
 * react-pdf rendering entry points (spec §5.4 Tier B). Scripts must not import this module
 * (spec §2.2); it runs in route handlers, `after()` outbox batches, cron and Vitest.
 */
export async function renderDisclosurePdf(
  doc: DisclosureDoc,
  text: { meta: string; footer: string },
): Promise<Uint8Array> {
  registerPdfFonts();
  // react-pdf types its element prop as a <Document> element; our component returns one.
  const element = createElement(DisclosurePdf, {
    doc,
    meta: text.meta,
    footer: text.footer,
  }) as unknown as Parameters<typeof renderToBuffer>[0];
  const buf = await renderToBuffer(element);
  return new Uint8Array(buf);
}
