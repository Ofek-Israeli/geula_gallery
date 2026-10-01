import "server-only";
import { createElement } from "react";
import { render } from "react-email";
import {
  EMAIL_TEMPLATES,
  type EmailBrand,
  type EmailContext,
  type EmailTemplate,
  type EmailTemplateId,
  type EmailTemplateProps,
} from "@/emails";
import type { Locale } from "@/lib/locale";
import { getUntypedTranslator } from "@/server/i18n";
import type { RenderedEmail } from "./types";

/**
 * Renders a template to subject, HTML and plain text with react-email 6.11.0 (`render` re-exported
 * from @react-email/render; verified at install). Pure apart from the translator cache, so it runs
 * in Route Handlers, `after()`, cron jobs and Vitest. Scripts must not import it (spec §2.2).
 */
export function effectiveLocale(
  template: EmailTemplateId,
  locale: Locale,
): Locale {
  return EMAIL_TEMPLATES[template].audience === "painter" ? "he" : locale;
}

export interface RenderOptions {
  locale: Locale;
  /** Seller identity for the footer in the effective locale. */
  brand: (locale: Locale) => EmailBrand;
  demo: boolean;
}

export async function renderEmail<K extends EmailTemplateId>(
  template: K,
  props: EmailTemplateProps[K],
  opts: RenderOptions,
): Promise<RenderedEmail> {
  const tpl = EMAIL_TEMPLATES[template] as unknown as EmailTemplate<
    EmailTemplateProps[K]
  >;
  const locale = effectiveLocale(template, opts.locale);
  const ctx: EmailContext = {
    locale,
    dir: locale === "he" ? "rtl" : "ltr",
    t: getUntypedTranslator(locale),
    brand: opts.brand(locale),
    demo: opts.demo,
  };
  const element = createElement(tpl.Component, { props, ctx });
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  const subject = tpl.subject(props, ctx).replace(/\s+/g, " ").trim();
  return { locale, subject, html, text };
}
