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

export function buildPreContract(
  _input: PreContractInput,
  _locale: Locale,
): PreContractDoc {
  throw new Error("buildPreContract is not implemented yet (owner: WS6)");
}

export function buildDisclosure(
  _input: DisclosureInput,
  _locale: Locale,
): DisclosureDoc {
  throw new Error("buildDisclosure is not implemented yet (owner: WS6)");
}
