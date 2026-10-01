/**
 * Pre-contract disclosures and the s.14C(b) disclosure document (spec §5.1, §5.4).
 * Frozen signatures (spec §9.3); WS6 implements the bodies. One builder feeds every renderer: the
 * checkout `PreContractDisclosure`, the HTML page `/[locale]/print/disclosure/[number]?k=`, the
 * inline email summary in `order-confirmation`, and (Tier B) the react-pdf PDF.
 *
 * Isomorphic UI-layer module: no `@/server` imports. Inputs carry everything the text needs, so
 * the builders stay pure and testable. The seller ID number appears here (noindex documents and
 * emails) and never on legal pages or the footer.
 */
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import type { DimensionsMm } from "@/lib/dimensions";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";

export type VatModeValue = "OSEK_PATUR" | "OSEK_MURSHE";
export type ShippingMethodValue =
  | "CARRIER_TABLE"
  | "LOCAL_PICKUP"
  | "ARTIST_DELIVERY"
  | "QUOTED";

export interface SellerIdentity {
  legalName: string;
  tradeName: string;
  /** ID / company number. Documents and emails only (never legal pages or the footer). */
  idNumber: string;
  vatMode: VatModeValue;
  vatNumber?: string;
  address: string;
  phoneLocal: string;
  phoneIntl: string;
  email: string;
}

export interface DisclosureWork {
  title: string;
  inventoryNumber: string;
  artistName: string;
  yearCreated?: number | null;
  /** Localized display text, e.g. "Oil on canvas". */
  mediumText: string;
  dimensions: DimensionsMm;
  framed: boolean;
  signed: boolean;
  coaIncluded: boolean;
  priceMinor: number;
}

export interface DisclosureLinks {
  terms: string;
  returns: string;
  privacy: string;
  shipping: string;
  cancel: string;
}

export interface PreContractInput {
  seller: SellerIdentity;
  works: DisclosureWork[];
  currency: Currency;
  itemsTotalMinor: number;
  shippingMinor: number;
  insuranceMinor: number;
  totalMinor: number;
  vatMinor: number;
  /** Zero-rated export (VAT 0) — accountant-confirmed wording. */
  zeroRatedExport: boolean;
  shippingMethod: ShippingMethodValue;
  /** Localized estimate, e.g. "3–5 business days". */
  deliveryEstimate: string;
  destinationCountry: string;
  /** Insurance is included in the quote (only then may the text say "insured"). */
  insured: boolean;
  maxInstallments: number;
  changeOfMindFee: "STATUTORY_MAX" | "NONE";
  /** International order: DAP duties notice. */
  international: boolean;
  links: DisclosureLinks;
  versions: { terms: string; returns: string; privacy: string };
}

export interface DisclosureInput extends PreContractInput {
  orderNumber: string;
  /** ISO timestamps. */
  orderedAt: string;
  paidAt: string;
  /** Selects the 4-month window text together with an eligible group (spec §5.7). */
  conversationTookPlace: boolean;
  paymentMethodText?: string;
  installments?: number;
  /** Expected dispatch/delivery date, ISO date. */
  deliveryDate?: string;
}

export const DISCLOSURE_SECTION_IDS = [
  "seller",
  "works",
  "price",
  "delivery",
  "payment",
  "cancellation",
  "duties",
  "copyright",
  "privacy",
  "links",
] as const;
export type DisclosureSectionId = (typeof DISCLOSURE_SECTION_IDS)[number];

export interface DocRow {
  label: string;
  value: string;
}

export interface DocSection {
  id: DisclosureSectionId;
  heading: string;
  paragraphs: string[];
  rows?: DocRow[];
}

export interface PreContractDoc {
  locale: Locale;
  /** `content/legal/versions.ts` disclosure version. */
  version: string;
  title: string;
  sections: DocSection[];
}

export interface DisclosureDoc extends PreContractDoc {
  orderNumber: string;
  issuedAt: string;
  /** Short lines for the inline email summary. */
  summary: string[];
}

// ---------------------------------------------------------------- pre-contract (M2 minimal)

const PRE_TEXT = {
  he: {
    title: "גילוי נאות לפני ההתקשרות",
    seller: "פרטי העוסק",
    legalName: "שם העוסק",
    tradeName: "שם מסחרי",
    idNumber: "מספר זהות / עוסק",
    address: "כתובת",
    phoneLocal: "טלפון",
    phoneIntl: "טלפון (מחו״ל)",
    email: "דוא״ל",
    merchantCountry: "מדינת העוסק",
    israel: "ישראל",
    service: "שירות לקוחות בטלפון ובדוא״ל, בימים א׳–ה׳.",
    works: "המוצר",
    original: "יצירה מקורית, עותק יחיד.",
    inventory: "מספר מלאי",
    artist: "אמן/ית",
    year: "שנה",
    medium: "טכניקה",
    dimensions: "מידות",
    framed: "ממוסגרת",
    signed: "חתומה",
    coa: "תעודת מקוריות",
    yes: "כן",
    no: "לא",
    price: "המחיר",
    items: "מחיר היצירה",
    shipping: "משלוח",
    insurance: "ביטוח משלוח",
    total: "סה״כ לתשלום",
    vatPatur: "עוסק פטור: המחיר אינו כולל מע״מ.",
    vatMurshe: "המחיר כולל מע״מ.",
    vatExport: "ייצוא: מע״מ בשיעור אפס (לאישור רואה החשבון).",
    delivery: "אספקה",
    method: "אופן המסירה",
    estimate: "מועד משוער",
    destination: "יעד",
    insured: "המשלוח מבוטח עד לערך היצירה (בכפוף לתקרה).",
    notInsured: "המשלוח עם מעקב.",
    payment: "תנאי תשלום",
    paymentText:
      "תשלום מלא מראש בעמוד התשלום המאובטח של ספק הסליקה. פרטי הכרטיס אינם עוברים דרך האתר.",
    installments: "עד {n} תשלומים, ללא ריבית.",
    cancellation: "ביטול העסקה",
    cancel14:
      "ניתן לבטל את העסקה תוך 14 ימים מיום קבלת היצירה או מסמך הגילוי, לפי המאוחר.",
    cancel4m:
      "אזרח/ית ותיק/ה, אדם עם מוגבלות או עולה חדש/ה (עד 5 שנים) שקיימו שיחה עם העוסק: עד 4 חודשים.",
    fee: "בביטול שלא בשל פגם ייתכן דמי ביטול של עד 5% מהמחיר או 100 ₪, הנמוך מביניהם.",
    noFee: "ללא דמי ביטול.",
    channels:
      'הודעת ביטול: בטופס המקוון "ביטול עסקה", בטלפון, בדוא״ל או בדואר רשום.',
    duties: "מכס ומסים",
    dap: "המשלוח לחו״ל הוא DAP: מכס, מע״מ יבוא ועמלות שחרור, אם יחולו, ישולמו על ידי הקונה ביעד.",
    privacy: "פרטיות",
    privacyText:
      "הפרטים נאספים לצורך ביצוע ההזמנה, המשלוח והחשבונית. אין חובה חוקית למסור אותם, אך בלעדיהם לא ניתן להשלים את הרכישה. הם יועברו לספק הסליקה ולחברת השילוח בלבד.",
    links: "מסמכים",
    terms: "תנאי מכירה",
    returns: "ביטולים והחזרות",
    privacyPolicy: "מדיניות פרטיות",
    shippingPolicy: "משלוחים ומכס",
    cancelForm: "טופס ביטול עסקה",
    methods: {
      CARRIER_TABLE: "שליח עד הבית",
      LOCAL_PICKUP: "איסוף עצמי מהסטודיו",
      ARTIST_DELIVERY: "מסירה אישית על ידי האמנית",
      QUOTED: "משלוח לפי הצעת מחיר",
    },
  },
  en: {
    title: "Pre-contract information",
    seller: "Seller",
    legalName: "Legal name",
    tradeName: "Trading name",
    idNumber: "ID / business number",
    address: "Address",
    phoneLocal: "Phone",
    phoneIntl: "Phone (international)",
    email: "Email",
    merchantCountry: "Merchant country",
    israel: "Israel",
    service: "Customer service by phone and email, Sunday to Thursday.",
    works: "The work",
    original: "An original work; a single copy.",
    inventory: "Inventory number",
    artist: "Artist",
    year: "Year",
    medium: "Medium",
    dimensions: "Dimensions",
    framed: "Framed",
    signed: "Signed",
    coa: "Certificate of authenticity",
    yes: "Yes",
    no: "No",
    price: "Price",
    items: "Price of the work",
    shipping: "Shipping",
    insurance: "Shipping insurance",
    total: "Total to pay",
    vatPatur: "VAT-exempt dealer: the price includes no VAT.",
    vatMurshe: "The price includes VAT.",
    vatExport:
      "Export: zero-rated for VAT (to be confirmed by the accountant).",
    delivery: "Delivery",
    method: "Method",
    estimate: "Estimated delivery",
    destination: "Destination",
    insured:
      "The shipment is insured up to the work's value (subject to a cap).",
    notInsured: "The shipment is tracked.",
    payment: "Payment terms",
    paymentText:
      "Full payment in advance on the payment provider's secure page. Card details never pass through this site.",
    installments: "Up to {n} interest-free instalments.",
    cancellation: "Cancellation",
    cancel14:
      "You may cancel within 14 days of receiving the work or this information, whichever is later.",
    cancel4m:
      "Senior citizens, people with disabilities and new immigrants (up to 5 years) who spoke with the seller: up to 4 months.",
    fee: "A cancellation not caused by a defect may carry a fee of up to 5% of the price or ₪100, whichever is lower.",
    noFee: "No cancellation fee.",
    channels:
      'Cancel through the online "Cancel a purchase" form, by phone, by email or by registered mail.',
    duties: "Duties and taxes",
    dap: "International shipments are DAP: import duties, VAT and clearance fees, if any, are paid by the buyer on delivery.",
    privacy: "Privacy",
    privacyText:
      "Your details are collected to fulfil the order, ship it and issue the receipt. You are not legally required to give them, but the purchase cannot be completed without them. They are shared only with the payment provider and the carrier.",
    links: "Documents",
    terms: "Terms of sale",
    returns: "Cancellations and returns",
    privacyPolicy: "Privacy policy",
    shippingPolicy: "Shipping and duties",
    cancelForm: "Cancellation form",
    methods: {
      CARRIER_TABLE: "Courier delivery",
      LOCAL_PICKUP: "Pickup from the studio",
      ARTIST_DELIVERY: "Hand delivery by the artist",
      QUOTED: "Quoted shipping",
    },
  },
} as const;

function money(minor: number, currency: Currency, locale: Locale): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-IL", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100);
}

function cm(mm: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-IL", {
    maximumFractionDigits: 1,
  }).format(mm / 10);
}

function regionName(code: string, locale: Locale): string {
  try {
    return (
      new Intl.DisplayNames([locale === "he" ? "he-IL" : "en-IL"], {
        type: "region",
      }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

/**
 * The checkout `PreContractDisclosure` (spec §5.1 step 2): seller identity including
 * "Merchant country: Israel", the work, the price with VAT wording per mode, delivery, payment
 * terms, cancellation rights (14 days; 4 months when eligible after a conversation), fee and
 * channels, the DAP notice, the s.11 privacy notice and links. M2 minimal text; WS6 owns the
 * final, lawyer-approved wording (and `buildDisclosure`).
 */
export function buildPreContract(
  input: PreContractInput,
  locale: Locale,
): PreContractDoc {
  const t = PRE_TEXT[locale];
  const yesNo = (b: boolean) => (b ? t.yes : t.no);
  const c = input.currency;
  const s = input.seller;
  const sections: DocSection[] = [
    {
      id: "seller",
      heading: t.seller,
      paragraphs: [t.service],
      rows: [
        { label: t.legalName, value: s.legalName },
        { label: t.tradeName, value: s.tradeName },
        { label: t.idNumber, value: s.idNumber },
        { label: t.address, value: s.address },
        { label: t.phoneLocal, value: s.phoneLocal },
        { label: t.phoneIntl, value: s.phoneIntl },
        { label: t.email, value: s.email },
        { label: t.merchantCountry, value: t.israel },
      ],
    },
    ...input.works.map(
      (w): DocSection => ({
        id: "works",
        heading: `${t.works}: ${w.title}`,
        paragraphs: [t.original],
        rows: [
          { label: t.inventory, value: w.inventoryNumber },
          { label: t.artist, value: w.artistName },
          ...(w.yearCreated
            ? [{ label: t.year, value: String(w.yearCreated) }]
            : []),
          { label: t.medium, value: w.mediumText },
          {
            label: t.dimensions,
            value: `${[w.dimensions.heightMm, w.dimensions.widthMm, ...(w.dimensions.depthMm ? [w.dimensions.depthMm] : [])].map((mm) => cm(mm, locale)).join(" × ")} cm`,
          },
          { label: t.framed, value: yesNo(w.framed) },
          { label: t.signed, value: yesNo(w.signed) },
          { label: t.coa, value: yesNo(w.coaIncluded) },
          { label: t.items, value: money(w.priceMinor, c, locale) },
        ],
      }),
    ),
    {
      id: "price",
      heading: t.price,
      paragraphs: [
        input.zeroRatedExport
          ? t.vatExport
          : s.vatMode === "OSEK_PATUR"
            ? t.vatPatur
            : t.vatMurshe,
      ],
      rows: [
        { label: t.items, value: money(input.itemsTotalMinor, c, locale) },
        { label: t.shipping, value: money(input.shippingMinor, c, locale) },
        ...(input.insuranceMinor > 0
          ? [
              {
                label: t.insurance,
                value: money(input.insuranceMinor, c, locale),
              },
            ]
          : []),
        { label: t.total, value: money(input.totalMinor, c, locale) },
      ],
    },
    {
      id: "delivery",
      heading: t.delivery,
      paragraphs: [input.insured ? t.insured : t.notInsured],
      rows: [
        { label: t.method, value: t.methods[input.shippingMethod] },
        {
          label: t.destination,
          value: regionName(input.destinationCountry, locale),
        },
        ...(input.deliveryEstimate
          ? [{ label: t.estimate, value: input.deliveryEstimate }]
          : []),
      ],
    },
    {
      id: "payment",
      heading: t.payment,
      paragraphs: [
        t.paymentText,
        ...(input.maxInstallments > 1
          ? [t.installments.replace("{n}", String(input.maxInstallments))]
          : []),
      ],
    },
    {
      id: "cancellation",
      heading: t.cancellation,
      paragraphs: [
        t.cancel14,
        t.cancel4m,
        input.changeOfMindFee === "STATUTORY_MAX" ? t.fee : t.noFee,
        t.channels,
      ],
    },
    ...(input.international
      ? [{ id: "duties" as const, heading: t.duties, paragraphs: [t.dap] }]
      : []),
    { id: "privacy", heading: t.privacy, paragraphs: [t.privacyText] },
    {
      id: "links",
      heading: t.links,
      paragraphs: [],
      rows: [
        { label: t.terms, value: input.links.terms },
        { label: t.returns, value: input.links.returns },
        { label: t.privacyPolicy, value: input.links.privacy },
        { label: t.shippingPolicy, value: input.links.shipping },
        { label: t.cancelForm, value: input.links.cancel },
      ],
    },
  ];
  return {
    locale,
    version: input.versions.terms,
    title: t.title,
    sections,
  };
}

// ---------------------------------------------------------------- disclosure (M2 minimal)

const DOC_TEXT = {
  he: {
    title: "מסמך גילוי לפי סעיף 14ג(ב) לחוק הגנת הצרכן",
    orderNumber: "מספר הזמנה",
    orderedAt: "מועד ההזמנה",
    paidAt: "מועד התשלום",
    paymentMethod: "אמצעי תשלום",
    installments: "מספר תשלומים",
    deliveryDate: "מועד אספקה משוער",
    copyright: "זכויות יוצרים",
    copyrightText:
      "זכויות היוצרים והזכות המוסרית ביצירה נשארות בידי האמנית. הרכישה מעבירה בעלות בעותק היחיד ואינה מעבירה זכות לשכפל אותו.",
    summaryOrder: "הזמנה {n}",
    summaryTotal: "סה״כ ששולם: {total}",
    summaryDelivery: "אספקה: {method}",
    summaryCancel:
      "ניתן לבטל תוך 14 ימים מקבלת היצירה או מסמך זה, המאוחר מביניהם (4 חודשים לזכאים לאחר שיחה עם העוסק).",
    summaryChannels:
      'ביטול: בטופס "ביטול עסקה" באתר, בטלפון, בדוא״ל או בדואר רשום.',
    summarySeller: "העוסק: {name}, {id}, {address}",
  },
  en: {
    title: "Disclosure document (Consumer Protection Law, s.14C(b))",
    orderNumber: "Order number",
    orderedAt: "Ordered at",
    paidAt: "Paid at",
    paymentMethod: "Payment method",
    installments: "Instalments",
    deliveryDate: "Estimated delivery",
    copyright: "Copyright",
    copyrightText:
      "Copyright and the moral rights in the work stay with the artist. The purchase transfers ownership of the single original; it grants no right to reproduce it.",
    summaryOrder: "Order {n}",
    summaryTotal: "Total paid: {total}",
    summaryDelivery: "Delivery: {method}",
    summaryCancel:
      "You may cancel within 14 days of receiving the work or this document, whichever is later (4 months for eligible buyers after a conversation with the seller).",
    summaryChannels:
      'Cancel through the "Cancel a purchase" form on the site, by phone, by email or by registered mail.',
    summarySeller: "Seller: {name}, {id}, {address}",
  },
} as const;

function dateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-IL", {
    timeZone: "Asia/Jerusalem",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");
}

/**
 * The s.14C(b) disclosure document (spec §5.4): the pre-contract content plus the order details,
 * the copyright note and a short summary for the inline email. M2 minimal text built on
 * `buildPreContract`; WS6 owns the final, lawyer-approved document (and the Tier B PDF).
 */
export function buildDisclosure(
  input: DisclosureInput,
  locale: Locale,
): DisclosureDoc {
  const pre = buildPreContract(input, locale);
  const t = DOC_TEXT[locale];
  const p = PRE_TEXT[locale];
  const orderRows: DocRow[] = [
    { label: t.orderNumber, value: input.orderNumber },
    { label: t.orderedAt, value: dateTime(input.orderedAt, locale) },
    { label: t.paidAt, value: dateTime(input.paidAt, locale) },
    ...(input.paymentMethodText
      ? [{ label: t.paymentMethod, value: input.paymentMethodText }]
      : []),
    ...(input.installments && input.installments > 1
      ? [{ label: t.installments, value: String(input.installments) }]
      : []),
    ...(input.deliveryDate
      ? [{ label: t.deliveryDate, value: input.deliveryDate }]
      : []),
  ];
  const sections = pre.sections.map((s) =>
    s.id === "payment" ? { ...s, rows: [...orderRows, ...(s.rows ?? [])] } : s,
  );
  const linksAt = sections.findIndex((s) => s.id === "links");
  const copyright: DocSection = {
    id: "copyright",
    heading: t.copyright,
    paragraphs: [t.copyrightText],
  };
  sections.splice(linksAt < 0 ? sections.length : linksAt, 0, copyright);
  const s = input.seller;
  return {
    locale,
    version: LEGAL_VERSIONS.disclosure,
    title: t.title,
    sections,
    orderNumber: input.orderNumber,
    issuedAt: input.paidAt,
    summary: [
      fill(t.summaryOrder, { n: input.orderNumber }),
      ...input.works.map((w) => `${w.title} (${w.inventoryNumber})`),
      fill(t.summaryTotal, {
        total: money(input.totalMinor, input.currency, locale),
      }),
      fill(t.summaryDelivery, { method: p.methods[input.shippingMethod] }),
      fill(t.summarySeller, {
        name: s.legalName,
        id: s.idNumber,
        address: s.address,
      }),
      t.summaryCancel,
      t.summaryChannels,
    ],
  };
}
