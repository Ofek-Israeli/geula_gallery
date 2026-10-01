import "server-only";
import { z } from "zod";
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
  email: z.email(),
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
  maxInstallments: z.number().int().min(1).default(1),
  paypalForIsraeliDestinations: z.boolean().default(false),
  receiptForRefundedPayments: z.boolean().default(true),
  conversationLookbackDays: z.number().int().min(0).default(365),
  fx: fxSchema,
});
export type CheckoutSettings = z.infer<typeof checkoutSettingsSchema>;

// ------------------------------------------------------------------ shipping
export const ZONE_IDS = [
  "IL",
  "EUROPE",
  "NORTH_AMERICA",
  "REST_OF_WORLD",
] as const;
export const zoneIdSchema = z.enum(ZONE_IDS);
export type ZoneId = z.infer<typeof zoneIdSchema>;

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
  kind: z.enum(["PERCENT", "FIXED"]),
  /** PERCENT: percentage of the base rate; FIXED: whole ILS per piece. */
  value: nonNegNum,
  /** Zones it applies to; empty = all carrier zones. */
  zones: z.array(zoneIdSchema).default([]),
  /** Optional time box, inclusive dates (Asia/Jerusalem). */
  from: isoDate.nullable().default(null),
  to: isoDate.nullable().default(null),
});

export const insuranceSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["DHL", "THIRD_PARTY", "NONE"]),
  ratePct: nonNegNum,
  minIls: nonNegNum,
  maxInsuredIls: nonNegNum,
  /** Null until the painter confirms coverage terms (a go-live blocker). */
  coverageConfirmedAt: isoDateTime.nullable(),
});

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
  artistDelivery: z.object({
    enabled: z.boolean(),
    feeIls: nonNegNum,
    /** Free-text service area shown at checkout. */
    area: localized,
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
