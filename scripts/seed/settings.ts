import { settings } from "@/server/db/schema";
import type { SettingsKey } from "@/server/db/schema/enums";
import {
  type BusinessProfile,
  type CancellationPolicy,
  type CheckoutSettings,
  parseSettings,
  type ShippingSettings,
} from "@/server/settings/schemas";
import type { SeedEnv, SeedModule } from "./types";

/**
 * Baseline settings rows (spec §8.4). Placeholders only: the real business identity lives only in
 * the DB and is entered by the painter in /admin/settings. Runs in every seed mode.
 * Idempotent: existing rows are left untouched so a re-seed never overwrites the painter's edits.
 */

const TBD_HE = "(למילוי)";
const TBD_EN = "(to be completed)";
const tbd = { he: TBD_HE, en: TBD_EN };

export function businessProfileDefaults(env: SeedEnv): BusinessProfile {
  return {
    legalName: TBD_HE,
    tradeName: { he: "גלריה גאולה", en: "Geula Gallery" },
    artistName: { he: TBD_HE, en: TBD_EN },
    signatureName: TBD_EN,
    idNumber: "000000018",
    vatMode: "OSEK_PATUR",
    address: tbd,
    returnAddress: tbd,
    phoneLocal: "03-000-0000",
    phoneIntl: "+972-3-000-0000",
    email: "studio@example.com",
    notificationEmail: env.adminEmail ?? "studio@example.com",
    accessibilityContact: "studio@example.com",
    privacyContact: "studio@example.com",
    pickupAddress: tbd,
    pickupInstructions: tbd,
    completed: false,
  };
}

export const checkoutDefaults: CheckoutSettings = {
  reservationMinutes: 35,
  linkHoursDefault: 48,
  maxActiveHoldsPerEmail: 2,
  maxActiveHoldsPerIp: 3,
  maxHoldsPerArtworkPerBuyer24h: 2,
  holdCooldownMinutes: 15,
  maxHoldCountPerOrder: 3,
  maxWebHoldSpanMinutes: 120,
  maxAttemptsPerOrder: 5,
  maxInstallments: 1,
  paypalForIsraeliDestinations: false,
  receiptForRefundedPayments: true,
  conversationLookbackDays: 365,
  // Placeholder reference rates (dated); never used to compute a charged amount.
  fx: { ilsPerUsd: 3.7, ilsPerEur: 4.0, ilsPerGbp: 4.7, asOf: "2026-10-01" },
};

const EUROPE = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
  "CH",
  "NO",
  "IS",
  "LI",
];

const INTERNATIONAL = ["EUROPE", "NORTH_AMERICA", "REST_OF_WORLD"] as const;

/** Placeholder rates and rules; `calibratedAt: null` keeps the "rates uncalibrated" alert on. */
export const shippingDefaults: ShippingSettings = {
  divisor: 5000,
  calibratedAt: null,
  zones: [
    {
      id: "IL",
      enabled: true,
      countries: ["IL"],
      estimate: { he: "3–5 ימי עסקים", en: "3–5 business days" },
    },
    {
      // Exists but disabled: EU targeting is deferred, so Europe routes to quote (spec §1.3).
      id: "EUROPE",
      enabled: false,
      countries: EUROPE,
      estimate: { he: "5–10 ימי עסקים", en: "5–10 business days" },
    },
    {
      id: "NORTH_AMERICA",
      enabled: true,
      countries: ["US", "CA"],
      estimate: { he: "5–10 ימי עסקים", en: "5–10 business days" },
    },
    {
      id: "REST_OF_WORLD",
      enabled: true,
      countries: ["*"],
      estimate: { he: "7–14 ימי עסקים", en: "7–14 business days" },
    },
  ],
  classRatesIls: {
    IL: { S: 60, M: 120, L: 250 },
    EUROPE: { S: 220, M: 480, L: 1100 },
    NORTH_AMERICA: { S: 260, M: 560, L: 1300 },
    REST_OF_WORLD: { S: 300, M: 650, L: 1500 },
  },
  oversizeFeeIls: 150,
  nonConveyableFeeIls: 200,
  surcharges: [
    {
      id: "fuel",
      label: { he: "היטל דלק", en: "Fuel surcharge" },
      enabled: true,
      kind: "PCT",
      value: 20,
      zones: [...INTERNATIONAL],
      startsOn: null,
      endsOn: null,
    },
    {
      id: "dhl-demand",
      label: { he: "היטל עונת שיא", en: "Peak season surcharge" },
      enabled: true,
      kind: "FIXED",
      value: 40,
      zones: [...INTERNATIONAL],
      startsOn: "2026-10-01",
      endsOn: "2027-02-05",
    },
    {
      id: "elevated-risk",
      label: { he: "היטל סיכון מוגבר", en: "Elevated risk surcharge" },
      enabled: false,
      kind: "FIXED",
      value: 0,
      zones: [...INTERNATIONAL],
      startsOn: null,
      endsOn: null,
    },
  ],
  insurance: {
    enabled: true,
    provider: "DHL",
    ratePct: 1.5,
    minIls: 50,
    maxInsuredIls: 10000,
    coverageConfirmedAt: null,
  },
  valueCaps: [{ carrier: "DHL", maxUsd: 2500 }],
  deniedCountries: ["IR", "SY", "LB", "IQ"],
  quoteOnlyCountries: [],
  thresholds: {
    gbLowValueGbp: 135,
    euLowValueEur: 150,
    usFormalEntryUsd: 2500,
    exportDeclarationUsd: 200,
  },
  localPickup: { enabled: true, feeIls: 0 },
  artistDelivery: {
    enabled: true,
    feeIls: 150,
    area: tbd,
  },
  domesticCarrierName: { he: "דואר ישראל", en: "Israel Post" },
};

export const cancellationPolicyDefaults: CancellationPolicy = {
  changeOfMindFee: "STATUTORY_MAX",
};

export function settingsSeedValues(
  env: SeedEnv,
): Partial<Record<SettingsKey, unknown>> {
  return {
    business_profile: businessProfileDefaults(env),
    checkout: checkoutDefaults,
    shipping: shippingDefaults,
    cancellation_policy: cancellationPolicyDefaults,
  };
}

export const settingsSeed: SeedModule = {
  name: "settings",
  modes: ["demo", "none"],
  async run({ db, env, log }) {
    const rows = Object.entries(settingsSeedValues(env)).map(([key, value]) => {
      const k = key as SettingsKey;
      return { key: k, value: parseSettings(k, value), updatedBy: "seed" };
    });
    const inserted = await db
      .insert(settings)
      .values(rows)
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    log(
      `settings: ${inserted.length} inserted, ${rows.length - inserted.length} already present`,
    );
  },
};
