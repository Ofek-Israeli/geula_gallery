/**
 * Legal pages registry (spec §6.2 `/legal/[doc]`): TSX drafts per locale, filled from the business
 * profile **without the ID number** (`LegalProfile` has no such field). `versions.ts`
 * `LEGAL_TEXTS_APPROVED=false` shows a DRAFT banner until the lawyer signs the texts off.
 */
import type { Locale } from "@/lib/locale";
import type { LegalDoc } from "@/lib/routes";
import { accessibility as enAccessibility } from "./en/accessibility";
import { privacy as enPrivacy } from "./en/privacy";
import { returns as enReturns } from "./en/returns";
import { shipping as enShipping } from "./en/shipping";
import { terms as enTerms } from "./en/terms";
import { accessibility as heAccessibility } from "./he/accessibility";
import { privacy as hePrivacy } from "./he/privacy";
import { returns as heReturns } from "./he/returns";
import { shipping as heShipping } from "./he/shipping";
import { terms as heTerms } from "./he/terms";
import type { LegalDocModule, LegalProfile } from "./types";

export type { LegalDocModule, LegalDocProps, LegalProfile } from "./types";

export const LEGAL_DOCUMENTS: Record<
  Locale,
  Record<LegalDoc, LegalDocModule>
> = {
  he: {
    terms: heTerms,
    returns: heReturns,
    shipping: heShipping,
    privacy: hePrivacy,
    accessibility: heAccessibility,
  },
  en: {
    terms: enTerms,
    returns: enReturns,
    shipping: enShipping,
    privacy: enPrivacy,
    accessibility: enAccessibility,
  },
};

/** The only way a legal page receives seller data: an explicit allowlist (never `idNumber`). */
export function toLegalProfile(
  profile: {
    legalName: string;
    tradeName: Record<Locale, string>;
    artistName: Record<Locale, string>;
    vatMode: "OSEK_PATUR" | "OSEK_MURSHE";
    address: Record<Locale, string>;
    returnAddress: Record<Locale, string>;
    phoneLocal: string;
    phoneIntl: string;
    email: string;
    accessibilityContact: string;
    privacyContact: string;
    pickupAddress: Record<Locale, string>;
  },
  locale: Locale,
): LegalProfile {
  return {
    legalName: profile.legalName,
    tradeName: profile.tradeName[locale],
    artistName: profile.artistName[locale],
    vatMode: profile.vatMode,
    address: profile.address[locale],
    returnAddress: profile.returnAddress[locale],
    phoneLocal: profile.phoneLocal,
    phoneIntl: profile.phoneIntl,
    email: profile.email,
    accessibilityContact: profile.accessibilityContact,
    privacyContact: profile.privacyContact,
    pickupAddress: profile.pickupAddress[locale],
  };
}
