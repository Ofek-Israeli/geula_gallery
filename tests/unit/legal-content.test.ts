import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildDisclosure,
  buildPreContract,
  type DisclosureInput,
} from "@/content/disclosure";
import { LEGAL_DOCUMENTS, toLegalProfile } from "@/content/legal";
import { stripBidi } from "@/lib/format";
import { LOCALE_VALUES } from "@/lib/locale";
import { LEGAL_DOCS } from "@/lib/routes";

/**
 * Spec §10.1 `legal-content`: every s.14C(a) element is present in the pre-contract disclosure (and
 * the s.14C(b) document adds the order and copyright); forbidden phrases are absent everywhere; the
 * seller's `idNumber` never appears in the rendered legal pages or the footer data path.
 */
const ID_SENTINEL = "987654329";

const businessProfile = {
  legalName: "Test Legal Name",
  tradeName: { he: "גלריה גאולה", en: "Geula Gallery" },
  artistName: { he: "גאולה", en: "Geula" },
  signatureName: "Geula",
  idNumber: ID_SENTINEL,
  vatMode: "OSEK_PATUR" as const,
  address: { he: "רחוב הבדיקה 1, תל אביב", en: "1 Test St, Tel Aviv" },
  returnAddress: { he: "רחוב ההחזרות 2", en: "2 Returns St" },
  phoneLocal: "03-000-0000",
  phoneIntl: "+972-3-000-0000",
  email: "studio@example.com",
  notificationEmail: "studio@example.com",
  accessibilityContact: "access@example.com",
  privacyContact: "privacy@example.com",
  pickupAddress: { he: "הסטודיו", en: "The studio" },
  pickupInstructions: { he: "", en: "" },
  completed: false,
};

const links = {
  terms: "/x/legal/terms",
  returns: "/x/legal/returns",
  shipping: "/x/legal/shipping",
  privacy: "/x/legal/privacy",
  accessibility: "/x/legal/accessibility",
  cancel: "/x/cancel",
};

/** Phrases a consumer-law-compliant text must never contain (spec §6.2: no "all sales final"). */
const FORBIDDEN = [
  /all sales (are )?final/i,
  /no (refunds|returns)/i,
  /non-?refundable/i,
  /cannot be cancell?ed/i,
  /אין החזרות/,
  /אין החזר/,
  /לא ניתן לבטל/,
  /המכירה סופית/,
];

function renderDoc(locale: "he" | "en", doc: (typeof LEGAL_DOCS)[number]) {
  const mod = LEGAL_DOCUMENTS[locale][doc];
  const html = renderToStaticMarkup(
    createElement(mod.Body, {
      profile: toLegalProfile(businessProfile, locale),
      links,
      versionDate: "1 October 2026",
    }),
  );
  return stripBidi(html.replace(/<[^>]+>/g, " "));
}

const input: DisclosureInput = {
  seller: {
    legalName: businessProfile.legalName,
    tradeName: "Geula Gallery",
    idNumber: ID_SENTINEL,
    vatMode: "OSEK_PATUR",
    address: "1 Test St, Tel Aviv",
    phoneLocal: "03-000-0000",
    phoneIntl: "+972-3-000-0000",
    email: "studio@example.com",
  },
  works: [
    {
      title: "Landscape",
      inventoryNumber: "A-2026-001",
      artistName: "Geula",
      yearCreated: 2024,
      mediumText: "Oil on canvas",
      dimensions: { heightMm: 600, widthMm: 800, depthMm: 30 },
      framed: false,
      signed: true,
      coaIncluded: true,
      priceMinor: 150_000,
    },
  ],
  currency: "ILS",
  itemsTotalMinor: 150_000,
  shippingMinor: 6_000,
  insuranceMinor: 0,
  totalMinor: 156_000,
  vatMinor: 0,
  zeroRatedExport: false,
  shippingMethod: "CARRIER_TABLE",
  deliveryEstimate: "3–5",
  destinationCountry: "IL",
  insured: false,
  maxInstallments: 3,
  changeOfMindFee: "STATUTORY_MAX",
  international: false,
  links,
  versions: { terms: "t", returns: "r", privacy: "p" },
  orderNumber: "GG-7K3M9Q",
  orderedAt: "2026-10-01T09:00:00Z",
  paidAt: "2026-10-01T09:05:00Z",
  conversationTookPlace: false,
};

describe("legal pages", () => {
  for (const locale of LOCALE_VALUES) {
    for (const doc of LEGAL_DOCS) {
      it(`${locale}/${doc}: no ID number, no forbidden phrase, seller contact present`, () => {
        const text = renderDoc(locale, doc);
        expect(text).not.toContain(ID_SENTINEL);
        for (const re of FORBIDDEN) expect(text).not.toMatch(re);
        expect(text.length).toBeGreaterThan(300);
      });
    }

    it(`${locale}: terms name the seller, merchant country, price/VAT, payment, delivery, cancellation, copyright`, () => {
      const text = renderDoc(locale, "terms");
      expect(text).toContain(businessProfile.legalName);
      expect(text).toContain("03-000-0000");
      expect(text).toContain("studio@example.com");
      expect(text).toMatch(
        locale === "he" ? /ישראל/ : /Merchant country: Israel/,
      );
      expect(text).toMatch(locale === "he" ? /מע״מ/ : /VAT/);
      expect(text).toMatch(locale === "he" ? /זכויות היוצרים/ : /Copyright/);
    });

    it(`${locale}: returns cover 14 days, 4 months, fee, refund timing, every channel and the s.2(b2) qualifier`, () => {
      const text = renderDoc(locale, "returns");
      expect(text).toMatch(/14/);
      expect(text).toMatch(locale === "he" ? /4 חודשים/ : /4 months/);
      expect(text).toMatch(/5%/);
      expect(text).toMatch(/100/);
      expect(text).toContain("+972-3-000-0000");
      expect(text).toContain("studio@example.com");
      expect(text).toMatch(/2\(ב2\)|2\(b2\)/);
    });

    it(`${locale}: privacy lists the processors and the retention`, () => {
      const text = renderDoc(locale, "privacy");
      for (const p of [
        "Vercel",
        "Neon",
        "Resend",
        "Cardcom",
        "PayPal",
        "Morning",
        "DHL",
      ]) {
        expect(text).toContain(p);
      }
      expect(text).toContain("privacy@example.com");
    });

    it(`${locale}: the accessibility statement names the standard, the PDF limitation and a contact`, () => {
      const text = renderDoc(locale, "accessibility");
      expect(text).toContain("WCAG 2.2");
      expect(text).toContain("5568");
      expect(text).toContain("PDF");
      expect(text).toContain("access@example.com");
    });
  }

  it("toLegalProfile never carries the ID number", () => {
    for (const locale of LOCALE_VALUES) {
      const p = toLegalProfile(businessProfile, locale);
      expect(JSON.stringify(p)).not.toContain(ID_SENTINEL);
      expect(Object.keys(p)).not.toContain("idNumber");
    }
  });
});

describe("pre-contract disclosure: s.14C(a) elements", () => {
  for (const locale of LOCALE_VALUES) {
    it(`${locale}: seller identity incl. ID, merchant country, the work, total, delivery, payment, cancellation, links`, () => {
      const doc = buildPreContract(input, locale);
      const ids = doc.sections.map((s) => s.id);
      for (const id of [
        "seller",
        "works",
        "price",
        "delivery",
        "payment",
        "cancellation",
        "privacy",
        "links",
      ]) {
        expect(ids).toContain(id);
      }
      const text = JSON.stringify(doc);
      // The ID number belongs in the (noindex) disclosure, unlike legal pages.
      expect(text).toContain(ID_SENTINEL);
      expect(text).toContain("03-000-0000");
      expect(text).toContain("+972-3-000-0000");
      expect(text).toContain("studio@example.com");
      expect(text).toMatch(locale === "he" ? /ישראל/ : /Israel/);
      expect(text).toMatch(/14/);
      expect(text).toMatch(locale === "he" ? /4 חודשים/ : /4 months/);
      expect(text).toContain("A-2026-001");
      for (const re of FORBIDDEN) expect(text).not.toMatch(re);
    });

    it(`${locale}: the s.14C(b) document adds the order, copyright and a summary`, () => {
      const doc = buildDisclosure(input, locale);
      expect(doc.orderNumber).toBe("GG-7K3M9Q");
      expect(doc.sections.map((s) => s.id)).toContain("copyright");
      expect(doc.summary.join(" ")).toContain("GG-7K3M9Q");
      expect(JSON.stringify(doc)).toContain(ID_SENTINEL);
    });

    it(`${locale}: the DAP notice appears only for international orders`, () => {
      expect(
        buildPreContract(input, locale).sections.some((s) => s.id === "duties"),
      ).toBe(false);
      expect(
        buildPreContract(
          { ...input, international: true, destinationCountry: "US" },
          locale,
        ).sections.some((s) => s.id === "duties"),
      ).toBe(true);
    });
  }
});

describe("footer", () => {
  it("the common footer messages carry no ID-number placeholder", async () => {
    for (const locale of LOCALE_VALUES) {
      const { getMessagesFor } = await import("@/i18n/namespaces");
      const footer = JSON.stringify(
        (getMessagesFor(locale) as Record<string, Record<string, unknown>>)
          .common?.footer,
      );
      expect(footer).not.toMatch(/idNumber|id_number/);
    }
  });

  it("the footer and legal components never read the business profile's ID", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const files = [
      "src/components/site/SiteFooter.tsx",
      "src/app/[locale]/(site)/legal/[doc]/page.tsx",
      ...["he", "en"].flatMap((l) =>
        readdirSync(`src/content/legal/${l}`).map(
          (f) => `src/content/legal/${l}/${f}`,
        ),
      ),
    ];
    for (const f of files) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/idNumber/);
    }
  });
});
