import "server-only";
import { ZONE_IDS } from "@/lib/countries";
import { jerusalemDateKey } from "@/lib/format";
import {
  type ShippingSettings,
  shippingSettingsSchema,
} from "@/server/settings/schemas";

/**
 * The shipping settings editor's form → a validated `ShippingSettings` (spec §4.7, §6.10). Pure.
 * Field names are flat (`zone.EUROPE.enabled`, `rate.IL.S`, `sur.0.value`, …). Money is in whole
 * units as in the settings row. Rules beyond the zod schema:
 * - IR, SY and LB stay on the deny list (IQ is removable; spec §4.4);
 * - "Mark calibrated today" and "Confirm the coverage terms today" stamp the time; otherwise the
 *   stored timestamps are kept;
 * - a surcharge row with an empty id is ignored (the blank "new" row), a ticked `remove` drops it.
 */
export type FormFields = Record<string, string | string[] | undefined>;

export const FIXED_DENIED = ["IR", "SY", "LB"] as const;

export type SettingsFormResult =
  | { ok: true; value: ShippingSettings }
  | { ok: false; code: "INVALID_SETTINGS" | "DENIED_FIXED"; details: string };

function one(f: FormFields, key: string): string {
  const v = f[key];
  return (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();
}
function on(f: FormFields, key: string): boolean {
  return one(f, key) === "on";
}
function num(f: FormFields, key: string): number {
  const raw = one(f, key).replace(",", ".");
  return raw === "" ? Number.NaN : Number(raw);
}
function codes(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function shippingSettingsFromForm(
  f: FormFields,
  current: ShippingSettings,
  now: Date,
): SettingsFormResult {
  const surcharges: unknown[] = [];
  for (let i = 0; i < 50; i++) {
    const id = one(f, `sur.${i}.id`);
    if (f[`sur.${i}.id`] === undefined) break;
    if (!id || on(f, `sur.${i}.remove`)) continue;
    const zonesText = one(f, `sur.${i}.zones`);
    surcharges.push({
      id,
      label: { he: one(f, `sur.${i}.labelHe`), en: one(f, `sur.${i}.labelEn`) },
      enabled: on(f, `sur.${i}.enabled`),
      kind: one(f, `sur.${i}.kind`) === "FIXED" ? "FIXED" : "PCT",
      value: num(f, `sur.${i}.value`),
      zones:
        zonesText === "" || zonesText.toUpperCase() === "ALL"
          ? "ALL"
          : codes(zonesText),
      startsOn: one(f, `sur.${i}.startsOn`) || null,
      endsOn: one(f, `sur.${i}.endsOn`) || null,
    });
  }

  const denied = codes(one(f, "deniedCountries"));
  const missing = FIXED_DENIED.filter((c) => !denied.includes(c));
  if (missing.length > 0) {
    return { ok: false, code: "DENIED_FIXED", details: missing.join(", ") };
  }

  const candidate = {
    divisor: num(f, "divisor"),
    calibratedAt: on(f, "markCalibrated")
      ? now.toISOString()
      : current.calibratedAt,
    zones: ZONE_IDS.map((id) => ({
      id,
      enabled: on(f, `zone.${id}.enabled`),
      countries: codes(one(f, `zone.${id}.countries`)),
      estimate: {
        he: one(f, `zone.${id}.estimateHe`),
        en: one(f, `zone.${id}.estimateEn`),
      },
    })),
    classRatesIls: Object.fromEntries(
      ZONE_IDS.map((id) => [
        id,
        {
          S: num(f, `rate.${id}.S`),
          M: num(f, `rate.${id}.M`),
          L: num(f, `rate.${id}.L`),
        },
      ]),
    ),
    oversizeFeeIls: num(f, "oversizeFeeIls"),
    nonConveyableFeeIls: num(f, "nonConveyableFeeIls"),
    surcharges,
    insurance: {
      enabled: on(f, "ins.enabled"),
      provider: one(f, "ins.provider") || "NONE",
      ratePct: num(f, "ins.ratePct"),
      minIls: num(f, "ins.minIls"),
      maxInsuredIls: num(f, "ins.maxInsuredIls"),
      coverageConfirmedAt: on(f, "ins.confirmToday")
        ? now.toISOString()
        : current.insurance.coverageConfirmedAt,
    },
    valueCaps: (["DHL", "MOCK", "MANUAL"] as const)
      .map((carrier) => ({ carrier, maxUsd: num(f, `cap.${carrier}`) }))
      .filter((c) => !Number.isNaN(c.maxUsd)),
    deniedCountries: denied,
    quoteOnlyCountries: codes(one(f, "quoteOnlyCountries")),
    thresholds: {
      gbLowValueGbp: num(f, "th.gbLowValueGbp"),
      euLowValueEur: num(f, "th.euLowValueEur"),
      usFormalEntryUsd: num(f, "th.usFormalEntryUsd"),
      exportDeclarationUsd: num(f, "th.exportDeclarationUsd"),
    },
    localPickup: {
      enabled: on(f, "pickup.enabled"),
      feeIls: num(f, "pickup.feeIls"),
    },
    artistDelivery: {
      enabled: on(f, "artist.enabled"),
      feeIls: num(f, "artist.feeIls"),
      area: { he: one(f, "artist.areaHe"), en: one(f, "artist.areaEn") },
    },
    domesticCarrierName: {
      he: one(f, "domestic.he"),
      en: one(f, "domestic.en"),
    },
  };
  const parsed = shippingSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_SETTINGS",
      details: parsed.error.issues
        .slice(0, 5)
        .map((i) => i.path.join("."))
        .join(", "),
    };
  }
  return { ok: true, value: parsed.data };
}

/** The values the form shows for a settings row (inverse of the parser, for tests and defaults). */
export function shippingSettingsToForm(s: ShippingSettings): FormFields {
  const f: FormFields = {
    divisor: String(s.divisor),
    oversizeFeeIls: String(s.oversizeFeeIls),
    nonConveyableFeeIls: String(s.nonConveyableFeeIls),
    deniedCountries: s.deniedCountries.join(", "),
    quoteOnlyCountries: s.quoteOnlyCountries.join(", "),
    "ins.provider": s.insurance.provider,
    "ins.ratePct": String(s.insurance.ratePct),
    "ins.minIls": String(s.insurance.minIls),
    "ins.maxInsuredIls": String(s.insurance.maxInsuredIls),
    "th.gbLowValueGbp": String(s.thresholds.gbLowValueGbp),
    "th.euLowValueEur": String(s.thresholds.euLowValueEur),
    "th.usFormalEntryUsd": String(s.thresholds.usFormalEntryUsd),
    "th.exportDeclarationUsd": String(s.thresholds.exportDeclarationUsd),
    "pickup.feeIls": String(s.localPickup.feeIls),
    "artist.feeIls": String(s.artistDelivery.feeIls),
    "artist.areaHe": s.artistDelivery.area.he,
    "artist.areaEn": s.artistDelivery.area.en,
    "domestic.he": s.domesticCarrierName.he,
    "domestic.en": s.domesticCarrierName.en,
  };
  if (s.insurance.enabled) f["ins.enabled"] = "on";
  if (s.localPickup.enabled) f["pickup.enabled"] = "on";
  if (s.artistDelivery.enabled) f["artist.enabled"] = "on";
  for (const z of s.zones) {
    if (z.enabled) f[`zone.${z.id}.enabled`] = "on";
    f[`zone.${z.id}.countries`] = z.countries.join(", ");
    f[`zone.${z.id}.estimateHe`] = z.estimate.he;
    f[`zone.${z.id}.estimateEn`] = z.estimate.en;
  }
  for (const id of ZONE_IDS) {
    const r = s.classRatesIls[id];
    if (!r) continue;
    f[`rate.${id}.S`] = String(r.S);
    f[`rate.${id}.M`] = String(r.M);
    f[`rate.${id}.L`] = String(r.L);
  }
  for (const c of s.valueCaps) f[`cap.${c.carrier}`] = String(c.maxUsd);
  s.surcharges.forEach((x, i) => {
    f[`sur.${i}.id`] = x.id;
    f[`sur.${i}.labelHe`] = x.label.he;
    f[`sur.${i}.labelEn`] = x.label.en;
    if (x.enabled) f[`sur.${i}.enabled`] = "on";
    f[`sur.${i}.kind`] = x.kind;
    f[`sur.${i}.value`] = String(x.value);
    f[`sur.${i}.zones`] = x.zones === "ALL" ? "ALL" : x.zones.join(", ");
    f[`sur.${i}.startsOn`] = x.startsOn ?? "";
    f[`sur.${i}.endsOn`] = x.endsOn ?? "";
  });
  return f;
}

/** "Today" in Jerusalem, for the editor's date hints. */
export function todayKey(now: Date): string {
  return jerusalemDateKey(now);
}
