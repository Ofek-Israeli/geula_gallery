import { NextIntlClientProvider } from "next-intl";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardForm } from "@/app/[locale]/(checkout)/checkout/pay/card/CardForm";
import { getMessagesFor } from "@/i18n/namespaces";
import { LOCALE_VALUES, type Locale } from "@/lib/locale";

/**
 * Our own card form (`/checkout/pay/card`), as the server renders it. Its card inputs must never
 * be part of a form submission: no `name`, no `action`; the browser's card autofill still works.
 */
function render(locale: Locale, maxInstallments = 1): string {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale,
        messages: getMessagesFor(locale),
        timeZone: "Asia/Jerusalem",
      } as ComponentProps<typeof NextIntlClientProvider>,
      createElement(CardForm, {
        payLabel: "Pay ₪3,200",
        maxInstallments,
        contactHref: `/${locale}/contact`,
      }),
    ),
  );
}

const tags = (html: string, name: string) =>
  html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];

describe("our own card form", () => {
  for (const locale of LOCALE_VALUES) {
    it(`${locale}: card number, expiry, CVV, name and ID; no input is ever submitted`, () => {
      const html = render(locale, 3);
      const inputs = tags(html, "input");
      for (const autocomplete of ["cc-number", "cc-exp", "cc-csc", "cc-name"]) {
        expect(
          inputs.some((i) => i.includes(`autoComplete="${autocomplete}"`)),
        ).toBe(true);
      }
      expect(inputs.length).toBeGreaterThanOrEqual(5);
      for (const tag of [...inputs, ...tags(html, "select")]) {
        expect(tag).not.toMatch(/\sname=/);
      }
      const [form] = tags(html, "form");
      expect(form).toContain('data-testid="card-form"');
      expect(form).not.toMatch(/\saction=|\smethod=/);
      expect(html).toContain('data-testid="card-submit"');
      expect(html).toContain("<select"); // installments when offered
    });
  }

  it("no installments select for a single payment", () => {
    expect(render("en", 1)).not.toContain("<select");
  });
});
