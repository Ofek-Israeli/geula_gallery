import { describe, expect, it } from "vitest";
import type { SettingsKey } from "@/server/db/schema/enums";
import {
  parseSettings,
  shippingSettingsSchema,
} from "@/server/settings/schemas";
import { settingsSeedValues } from "../../scripts/seed/settings";

const seedEnv = {
  authBaseUrl: "http://localhost:3000",
  seedE2eUsers: false,
  e2eAdminPassword: "unused-password",
};

describe("settings schemas", () => {
  it("accept every seeded settings row", () => {
    const values = settingsSeedValues(seedEnv);
    for (const [key, value] of Object.entries(values)) {
      expect(() => parseSettings(key as SettingsKey, value), key).not.toThrow();
    }
  });

  it("use the spec's surcharge shape (PCT/FIXED, ALL or listed zones, inclusive window)", () => {
    const shipping = settingsSeedValues(seedEnv).shipping;
    const parsed = shippingSettingsSchema.parse(shipping);
    const peak = parsed.surcharges.find((s) => s.startsOn !== null);
    expect(peak).toMatchObject({
      startsOn: "2026-10-01",
      endsOn: "2027-02-05",
    });
    const bad = structuredClone(parsed);
    (bad.surcharges[0] as { kind: string }).kind = "PERCENT";
    expect(shippingSettingsSchema.safeParse(bad).success).toBe(false);
    const all = structuredClone(parsed);
    (all.surcharges[0] as { zones: unknown }).zones = "ALL";
    expect(shippingSettingsSchema.safeParse(all).success).toBe(true);
  });
});
