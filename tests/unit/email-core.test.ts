import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_IDS,
  EMAIL_TEMPLATES,
  type EmailBrand,
  type EmailTemplateId,
  type EmailTemplateProps,
  PAINTER_TEMPLATE_IDS,
} from "@/emails";
import type { Locale } from "@/lib/locale";
import { effectiveLocale, renderEmail } from "@/server/email/render";

const ID_NUMBER = "000000018";

const brand = (locale: Locale): EmailBrand => ({
  tradeName: locale === "he" ? "גלריה גאולה" : "Geula Gallery",
  address:
    locale === "he" ? "רחוב הדוגמה 1, תל אביב" : "1 Example St, Tel Aviv",
  email: "studio@example.com",
  phone: locale === "he" ? "03-000-0000" : "+972-3-000-0000",
  cancelUrl: `http://localhost:3000/${locale}/cancel`,
  siteUrl: `http://localhost:3000/${locale}`,
});

const order = {
  orderNumber: "GG-7K3M9Q",
  buyerName: "Dana",
  orderUrl: "http://localhost:3000/en/orders/GG-7K3M9Q?k=x",
};

const PROPS: { [K in EmailTemplateId]: EmailTemplateProps[K] } = {
  "order-confirmation": {
    ...order,
    items: [{ title: "Untitled", amountMinor: 120000 }],
    currency: "ILS",
    shippingMinor: 0,
    insuranceMinor: 0,
    totalMinor: 120000,
    paidAt: "2026-10-01T10:00:00Z",
    disclosure: {
      locale: "en",
      version: "draft-1",
      title: "Disclosure",
      sections: [],
      orderNumber: order.orderNumber,
      issuedAt: "2026-10-01T10:00:00Z",
      summary: [],
    },
    disclosureUrl: "http://localhost:3000/en/print/disclosure/GG-7K3M9Q?k=x",
  },
  "payment-review": order,
  "purchase-not-completed": {
    ...order,
    reason: "LOST_BEFORE_CAPTURE",
    charged: false,
    currency: "ILS",
  },
  "shipment-update": {
    ...order,
    status: "IN_TRANSIT",
    carrierName: "MOCK",
    dhlAttribution: false,
  },
  "ready-for-pickup": {
    ...order,
    pickupAddress: "Studio",
    pickupInstructions: "Call ahead",
  },
  receipt: {
    ...order,
    docNumber: "DEMO-000123",
    docUrl: "http://localhost:3000/en/print/receipt/GG-7K3M9Q?k=x",
    isDemoDocument: true,
  },
  "checkout-link": {
    ...order,
    artworkTitle: "Untitled",
    payUrl: "http://localhost:3000/en/orders/GG-7K3M9Q?k=x",
    expiresAt: "2026-10-03T10:00:00Z",
    totalMinor: 120000,
    currency: "ILS",
  },
  "request-ack": { name: "Dana", kind: "QUESTION", message: "Hi" },
  "request-reply": { name: "Dana", reply: "Hello" },
  "cancellation-ack": {
    cancellationNumber: "C-7K3M9Q",
    fullName: "Dana",
    idNumberMasked: "•••••••18",
    channel: "WEB",
    receivedAt: "2026-10-01T10:00:00Z",
    refundDueAt: "2026-10-15T10:00:00Z",
  },
  "return-instructions": {
    ...order,
    cancellationNumber: "C-7K3M9Q",
    returnAddress: "Studio",
    refundAmountMinor: 120000,
    currency: "ILS",
  },
  "refund-issued": { ...order, amountMinor: 120000, currency: "ILS" },
  "painter-new-order": {
    orderNumber: order.orderNumber,
    adminOrderUrl: "http://localhost:3000/he/admin/orders/1",
    buyerName: "Dana",
    buyerCountry: "IL",
    items: [{ title: "Untitled", amountMinor: 120000 }],
    totalMinor: 120000,
    currency: "ILS",
    isDemo: true,
  },
  "painter-new-request": {
    adminRequestUrl: "http://localhost:3000/he/admin/inbox/1",
    kind: "QUOTE",
    name: "Dana",
    email: "dana@example.test",
    message: "Quote please",
  },
  "painter-cancellation": {
    cancellationNumber: "C-7K3M9Q",
    adminCancellationUrl: "http://localhost:3000/he/admin/cancellations/1",
    fullName: "Dana",
    idNumberMasked: "•••••••18",
    channel: "WEB",
    receivedAt: "2026-10-01T10:00:00Z",
    refundDueAt: "2026-10-15T10:00:00Z",
    possibleDuplicate: false,
  },
  "admin-alert": {
    severity: "CRITICAL",
    kind: "OUTBOX_JOB_DEAD",
    message: "A job failed",
    adminAlertsUrl: "http://localhost:3000/he/admin/alerts",
  },
};

describe("email template registry", () => {
  it("has a template for every id and no advertising template", () => {
    expect(Object.keys(EMAIL_TEMPLATES).sort()).toEqual(
      [...EMAIL_TEMPLATE_IDS].sort(),
    );
    expect(EMAIL_TEMPLATE_IDS).toHaveLength(16);
    for (const id of EMAIL_TEMPLATE_IDS) {
      expect(id).not.toMatch(/newsletter|promo|marketing|notify-me/);
    }
  });

  it("painter templates are always Hebrew", () => {
    for (const id of PAINTER_TEMPLATE_IDS) {
      expect(EMAIL_TEMPLATES[id].audience).toBe("painter");
      expect(effectiveLocale(id, "en")).toBe("he");
    }
    expect(effectiveLocale("order-confirmation", "en")).toBe("en");
  });
});

describe("renderEmail", () => {
  for (const id of EMAIL_TEMPLATE_IDS) {
    for (const locale of ["he", "en"] as const) {
      it(`${id} (${locale}) sets lang/dir and the footer without the ID number`, async () => {
        const out = await renderEmail(id, PROPS[id] as never, {
          locale,
          brand,
          demo: true,
        });
        const expected = effectiveLocale(id, locale);
        expect(out.locale).toBe(expected);
        expect(out.html).toContain(`lang="${expected}"`);
        expect(out.html).toContain(
          `dir="${expected === "he" ? "rtl" : "ltr"}"`,
        );
        expect(out.subject.length).toBeGreaterThan(0);
        expect(out.subject).not.toMatch(/\n/);
        // footer: seller identity, merchant country, cancellation channels, demo note
        const b = brand(expected);
        expect(out.html).toContain(b.email);
        expect(out.html).toContain(b.cancelUrl);
        // phones are isolated LTR runs that never wrap (spec §6.4); the text part is unchanged
        expect(out.html).toMatch(
          new RegExp(
            `<span dir="ltr" style="[^"]*white-space:nowrap[^"]*">${b.phone.replace("+", "\\+")}</span>`,
          ),
        );
        expect(out.text).toContain(`(${b.phone})`);
        expect(out.text).not.toContain("⟦");
        expect(out.text).toContain(
          expected === "he" ? "מדינת העוסק: ישראל" : "Merchant country: Israel",
        );
        expect(out.text).toContain(
          expected === "he" ? "ביטול עסקה" : "Cancel a purchase",
        );
        // never the full ID number, anywhere
        expect(out.html).not.toContain(ID_NUMBER);
        expect(out.text).not.toContain(ID_NUMBER);
        // no unresolved message keys
        expect(out.text).not.toMatch(/emails-core\./);
      });
    }
  }
});
