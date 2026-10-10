import "server-only";
import { z } from "zod";
import { ZONE_IDS } from "@/lib/countries";
import type { SettingsKey } from "@/server/db/schema/enums";

/**
 * Zod schemas for the JSONB `settings` rows (spec §4.7). Frozen contract at `contracts-v1`.
 * Money in settings is in whole ILS/USD/GBP/EUR units (names end in Ils/Usd/...), unlike DB columns
 * which use integer minor units.
 */

const localized = z.object({ he: z.string(), en: z.string() });
const isoCountry = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2");
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const nonNegInt = z.number().int().nonnegative();
const nonNegNum = z.number().nonnegative();

// ------------------------------------------------------------------ business_profile
export const businessProfileSchema = z.object({
  legalName: z.string(),
  tradeName: localized,
  artistName: localized,
  signatureName: z.string(),
  /** Israeli ID / business number. Only on noindex pages, documents and emails. */
  idNumber: z.string(),
  vatMode: z.enum(["OSEK_PATUR", "OSEK_MURSHE"]),
  vatNumber: z.string().optional(),
  address: localized,
  returnAddress: localized,
  phoneLocal: z.string(),
  phoneIntl: z.string(),
  /**
   * The public email for buyers. Empty: no email is shown anywhere (site, documents, buyer emails);
   * visitors write through the contact form, which goes to `notificationEmail` (never shown).
   */
  email: z.union([z.email(), z.literal("")]),
  notificationEmail: z.email(),
  accessibilityContact: z.string(),
  privacyContact: z.string(),
  pickupAddress: localized,
  pickupInstructions: localized,
  /** False until the painter fills in the real profile (a go-live blocker). */
  completed: z.boolean(),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

// ------------------------------------------------------------------ checkout
export const fxSchema = z.object({
  ilsPerUsd: z.number().positive(),
  ilsPerEur: z.number().positive(),
  ilsPerGbp: z.number().positive(),
  asOf: isoDate,
});

export const checkoutSettingsSchema = z.object({
  reservationMinutes: z.number().int().min(1).default(35),
  linkHoursDefault: z.number().int().min(1).default(48),
  maxActiveHoldsPerEmail: z.number().int().min(1).default(2),
  maxActiveHoldsPerIp: z.number().int().min(1).default(3),
  maxHoldsPerArtworkPerBuyer24h: z.number().int().min(1).default(2),
  holdCooldownMinutes: nonNegInt.default(15),
  maxHoldCountPerOrder: z.number().int().min(1).default(3),
  maxWebHoldSpanMinutes: z.number().int().min(1).default(120),
  maxAttemptsPerOrder: z.number().int().min(1).max(5).default(5),
  /** Works per cart checkout, and live held works per buyer (email or IP) across orders. */
  maxCartItems: z.number().int().min(1).max(20).default(10),
  maxInstallments: z.number().int().min(1).default(1),
  paypalForIsraeliDestinations: z.boolean().default(false),
  receiptForRefundedPayments: z.boolean().default(true),
  conversationLookbackDays: z.number().int().min(0).default(365),
  fx: fxSchema,
});
export type CheckoutSettings = z.infer<typeof checkoutSettingsSchema>;

// ------------------------------------------------------------------ shipping
export { ZONE_IDS, type ZoneId } from "@/lib/countries";
export const zoneIdSchema = z.enum(ZONE_IDS);

export const shippingZoneSchema = z.object({
  id: zoneIdSchema,
  enabled: z.boolean(),
  /** ISO codes; `"*"` matches every country not listed in another zone (REST_OF_WORLD). */
  countries: z.array(z.union([isoCountry, z.literal("*")])),
  estimate: localized,
});

const classRatesSchema = z.object({
  S: nonNegNum,
  M: nonNegNum,
  L: nonNegNum,
});

export const surchargeSchema = z.object({
  id: z.string().min(1),
  label: localized,
  enabled: z.boolean(),
  /** PCT: percentage of the base class rate; FIXED: whole ILS per piece. */
  kind: z.enum(["PCT", "FIXED"]),
  value: nonNegNum,
  /** `"ALL"` or the listed zones (spec §4.4). */
  zones: z.union([z.literal("ALL"), z.array(zoneIdSchema).min(1)]),
  /** Optional time box; active when `startsOn ≤ date ≤ endsOn` (inclusive, Asia/Jerusalem). */
  startsOn: isoDate.nullable().default(null),
  endsOn: isoDate.nullable().default(null),
});
export type Surcharge = z.infer<typeof surchargeSchema>;

export const insuranceSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["DHL", "THIRD_PARTY", "NONE"]),
  ratePct: nonNegNum,
  minIls: nonNegNum,
  maxInsuredIls: nonNegNum,
  /** Null until the painter confirms coverage terms (a go-live blocker). */
  coverageConfirmedAt: isoDateTime.nullable(),
});

/**
 * The DHL Express estimate abroad (`shipping/dhl-estimate.ts`): DHL's published tariff in code, plus
 * what changes between guides. DHL updates the fuel surcharge weekly (the painter copies it from
 * DHL's surcharges page); the discount is the account rate off the published prices (0 = list
 * prices). `exportDeclarationByDhl`: DHL files the export declaration (its published fee is added
 * when the value is above `thresholds.exportDeclarationUsd`); off when the painter files it.
 * Every field has a default, so rows saved before it existed still parse.
 */
export const dhlEstimateSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  fuelSurchargePct: z.number().min(0).max(100).default(49),
  fuelSurchargeAsOf: isoDate.default("2026-10-12"),
  accountDiscountPct: z.number().min(0).max(100).default(0),
  exportDeclarationByDhl: z.boolean().default(true),
});
export type DhlEstimateSettings = z.infer<typeof dhlEstimateSettingsSchema>;

/**
 * Israel Post at its published prices (`shipping/israel-post.ts`): home delivery in Israel and EMS
 * abroad, offered next to the courier when the parcel fits Israel Post's limits. `insureAbroad`
 * adds Israel Post's EMS liability extension (while `insurance.enabled`). The delivery times are
 * shown to the buyer. Every field has a default, so rows saved before it existed still parse.
 */
export const israelPostSettingsSchema = z.object({
  domestic: z.boolean().default(true),
  abroad: z.boolean().default(true),
  insureAbroad: z.boolean().default(true),
  estimate: z
    .object({
      domestic: localized.default({
        he: "1–2 ימי עסקים",
        en: "1–2 business days",
      }),
      abroad: localized.default({
        he: "5–10 ימי עסקים",
        en: "5–10 business days",
      }),
    })
    .prefault({}),
});
export type IsraelPostSettings = z.infer<typeof israelPostSettingsSchema>;

export const shippingSettingsSchema = z.object({
  /** Volumetric divisor (cm³ per kg). */
  divisor: z.number().int().positive().default(5000),
  /** Null until the painter calibrates the placeholder rates (alert). */
  calibratedAt: isoDateTime.nullable(),
  zones: z.array(shippingZoneSchema),
  classRatesIls: z.record(zoneIdSchema, classRatesSchema),
  oversizeFeeIls: nonNegNum,
  nonConveyableFeeIls: nonNegNum,
  surcharges: z.array(surchargeSchema),
  dhlEstimate: dhlEstimateSettingsSchema.prefault({}),
  israelPost: israelPostSettingsSchema.prefault({}),
  insurance: insuranceSettingsSchema,
  valueCaps: z.array(
    z.object({
      carrier: z.enum(["MOCK", "MANUAL", "DHL"]),
      maxUsd: z.number().positive(),
    }),
  ),
  deniedCountries: z.array(isoCountry),
  quoteOnlyCountries: z.array(isoCountry),
  thresholds: z.object({
    gbLowValueGbp: nonNegNum.default(135),
    euLowValueEur: nonNegNum.default(150),
    usFormalEntryUsd: nonNegNum.default(2500),
    exportDeclarationUsd: nonNegNum.default(200),
  }),
  localPickup: z.object({
    enabled: z.boolean(),
    feeIls: nonNegNum.default(0),
  }),
  domesticCarrierName: localized,
});
export type ShippingSettings = z.infer<typeof shippingSettingsSchema>;

// ------------------------------------------------------------------ cancellation_policy
export const cancellationPolicySchema = z.object({
  /** A suggestion only; the admin may lower the fee, never raise it. */
  changeOfMindFee: z.enum(["STATUTORY_MAX", "NONE"]).default("STATUTORY_MAX"),
});
export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>;

// ------------------------------------------------------------------ site_content (P1)
export const siteContentSchema = z.record(z.string(), z.unknown());
export type SiteContent = z.infer<typeof siteContentSchema>;

// ------------------------------------------------------------------ registry
export const settingsSchemas = {
  business_profile: businessProfileSchema,
  checkout: checkoutSettingsSchema,
  shipping: shippingSettingsSchema,
  cancellation_policy: cancellationPolicySchema,
  site_content: siteContentSchema,
} as const satisfies Record<SettingsKey, z.ZodType>;

export type SettingsValue<K extends SettingsKey> = z.infer<
  (typeof settingsSchemas)[K]
>;

/** Validate a settings value for `key`; throws a ZodError on invalid input. */
export function parseSettings<K extends SettingsKey>(
  key: K,
  value: unknown,
): SettingsValue<K> {
  return settingsSchemas[key].parse(value) as SettingsValue<K>;
}
