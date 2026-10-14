import { NextIntlClientProvider } from "next-intl";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import {
  CheckoutForm,
  type CheckoutFormProps,
} from "@/app/[locale]/(checkout)/checkout/_components/CheckoutForm";
import { getMessagesFor } from "@/i18n/namespaces";
import { LOCALE_VALUES, type Locale } from "@/lib/locale";

/**
 * The payment part of the checkout form (`CheckoutForm`), rendered on the server as the details
 * step first arrives. In the preview (`CHECKOUT_PREVIEW`) before a provider is configured the
 * quote offers no provider: the form says "activation pending", posts no provider and cannot
 * submit, and does not promise a hold.
 */
function render(
  locale: Locale,
  providers: CheckoutFormProps["providers"],
): string {
  const props: CheckoutFormProps = {
    action: async (prev) => prev,
    locale,
    hidden: {
      slug: "the-path",
      country: "IL",
      method: "LOCAL_PICKUP",
      currency: "ILS",
      expectedTotalMinor: 320_000,
      clientRequestId: "0d4f7a52-6a1e-4c1e-9b8e-0f6f6e6b8a11",
      formStart: "0",
    },
    destination: {
      city: "Tel Aviv",
      postalCode: "6100000",
      countryName: "Israel",
    },
    needsAddress: false,
    international: false,
    holdMinutes: 35,
    itemCount: 1,
    providers,
    contactHref: `/${locale}/contact`,
    cardBrands: [],
    disclosure: null,
    reloadHref: `/${locale}/checkout/the-path`,
    changeDestinationHref: `/${locale}/checkout/the-path?step=destination`,
  };
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale,
        messages: getMessagesFor(locale),
        timeZone: "Asia/Jerusalem",
      } as ComponentProps<typeof NextIntlClientProvider>,
      createElement(CheckoutForm, props),
    ),
  );
}

function holdNotice(locale: Locale): string {
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: "checkout",
  });
  return t("holdNotice", { minutes: 35, count: 1 });
}

/** The opening tag of the first element with `attr` (attribute order varies). */
const tagWith = (html: string, attr: string) =>
  html.match(/<[a-z]+\b[^>]*>/g)?.find((tag) => tag.includes(attr)) ?? "";
const submitTag = (html: string) =>
  tagWith(html, 'data-testid="checkout-submit"');

describe("checkout form: payment methods", () => {
  for (const locale of LOCALE_VALUES) {
    it(`${locale}: no provider yet → activation pending, nothing to post, no hold promised`, () => {
      const html = render(locale, []);
      expect(html).toContain('data-testid="payments-pending"');
      expect(html).toContain(`href="/${locale}/contact"`);
      expect(tagWith(html, 'name="providerPending"')).toContain('disabled=""');
      expect(html).not.toContain('name="providerId"');
      expect(submitTag(html)).toContain('disabled=""');
      expect(html).not.toContain(holdNotice(locale));
      // What the card page will ask for, and why the button is off (read with the button).
      expect(html).toContain('data-testid="checkout-card-page"');
      expect(submitTag(html)).toContain('aria-describedby="co-submit-pending"');
      expect(tagWith(html, 'id="co-submit-pending"')).toMatch(/^<p\b/);
    });

    it(`${locale}: a provider → its radio, an enabled submit and the hold notice`, () => {
      const html = render(locale, [
        { id: "isracard", label: "Credit card – Isracard secure payment" },
      ]);
      expect(html).not.toContain('data-testid="payments-pending"');
      expect(tagWith(html, 'name="providerId"')).toContain('value="isracard"');
      expect(submitTag(html)).not.toContain('disabled=""');
      expect(submitTag(html)).not.toContain("aria-describedby");
      expect(html).toContain(holdNotice(locale));
      expect(html).toContain('data-testid="checkout-card-page"');
    });

    it(`${locale}: another provider's page is not described as Isracard's`, () => {
      const html = render(locale, [{ id: "mock", label: "Test payment" }]);
      expect(html).not.toContain('data-testid="checkout-card-page"');
    });
  }
});
