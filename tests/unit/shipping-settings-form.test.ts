import { describe, expect, it } from "vitest";
import {
  shippingSettingsFromForm,
  shippingSettingsToForm,
} from "@/server/shipping/settings-form";
import { shippingDefaults } from "../../scripts/seed/settings";

const NOW = new Date("2026-10-01T09:00:00Z");

describe("shipping settings form", () => {
  it("round-trips the seeded settings unchanged", () => {
    const res = shippingSettingsFromForm(
      shippingSettingsToForm(shippingDefaults),
      shippingDefaults,
      NOW,
    );
    expect(res).toEqual({ ok: true, value: shippingDefaults });
  });

  it("edits rates, zones, surcharges and stamps calibration and coverage", () => {
    const f = shippingSettingsToForm(shippingDefaults);
    f["rate.IL.S"] = "65";
    f["zone.EUROPE.enabled"] = "on";
    f["sur.0.remove"] = "on";
    const n = shippingDefaults.surcharges.length;
    f[`sur.${n}.id`] = "peak";
    f[`sur.${n}.labelHe`] = "עונת שיא";
    f[`sur.${n}.labelEn`] = "Peak";
    f[`sur.${n}.enabled`] = "on";
    f[`sur.${n}.kind`] = "FIXED";
    f[`sur.${n}.value`] = "25";
    f[`sur.${n}.zones`] = "north_america, EUROPE";
    f[`sur.${n}.startsOn`] = "2026-11-01";
    f[`sur.${n}.endsOn`] = "";
    f.markCalibrated = "on";
    f["ins.confirmToday"] = "on";
    const res = shippingSettingsFromForm(f, shippingDefaults, NOW);
    if (!res.ok) throw new Error(res.details);
    expect(res.value.classRatesIls.IL?.S).toBe(65);
    expect(res.value.zones.find((z) => z.id === "EUROPE")?.enabled).toBe(true);
    expect(res.value.surcharges.map((s) => s.id)).toEqual([
      ...shippingDefaults.surcharges.slice(1).map((s) => s.id),
      "peak",
    ]);
    expect(res.value.surcharges.at(-1)).toMatchObject({
      kind: "FIXED",
      value: 25,
      zones: ["NORTH_AMERICA", "EUROPE"],
      startsOn: "2026-11-01",
      endsOn: null,
    });
    expect(res.value.calibratedAt).toBe(NOW.toISOString());
    expect(res.value.insurance.coverageConfirmedAt).toBe(NOW.toISOString());
  });

  it("edits the DHL estimate: fuel surcharge and its date, discount, export declaration", () => {
    const f = shippingSettingsToForm(shippingDefaults);
    f["dhl.fuelPct"] = "50.25";
    f["dhl.fuelAsOf"] = "2026-10-19";
    f["dhl.discountPct"] = "35";
    delete f["dhl.exportDecl"];
    const res = shippingSettingsFromForm(f, shippingDefaults, NOW);
    if (!res.ok) throw new Error(res.details);
    expect(res.value.dhlEstimate).toEqual({
      enabled: true,
      fuelSurchargePct: 50.25,
      fuelSurchargeAsOf: "2026-10-19",
      accountDiscountPct: 35,
      exportDeclarationByDhl: false,
    });
    // An empty date keeps the stored one; an out-of-range fuel % is refused with its path.
    f["dhl.fuelAsOf"] = "";
    f["dhl.fuelPct"] = "120";
    const bad = shippingSettingsFromForm(f, shippingDefaults, NOW);
    expect(bad).toMatchObject({
      ok: false,
      details: expect.stringContaining("dhlEstimate.fuelSurchargePct"),
    });
  });

  it("keeps the stored DHL estimate when the form has no DHL fields (an older page)", () => {
    const f = shippingSettingsToForm(shippingDefaults);
    for (const k of Object.keys(f)) if (k.startsWith("dhl.")) delete f[k];
    const stored = {
      ...shippingDefaults,
      dhlEstimate: { ...shippingDefaults.dhlEstimate, accountDiscountPct: 20 },
    };
    const res = shippingSettingsFromForm(f, stored, NOW);
    if (!res.ok) throw new Error(res.details);
    expect(res.value.dhlEstimate).toEqual(stored.dhlEstimate);
  });

  it("keeps IR, SY and LB blocked; IQ is removable", () => {
    const f = shippingSettingsToForm(shippingDefaults);
    f.deniedCountries = "IR, SY, LB";
    const ok = shippingSettingsFromForm(f, shippingDefaults, NOW);
    expect(ok.ok && ok.value.deniedCountries).toEqual(["IR", "SY", "LB"]);
    f.deniedCountries = "IR, SY";
    expect(shippingSettingsFromForm(f, shippingDefaults, NOW)).toMatchObject({
      ok: false,
      code: "DENIED_FIXED",
      details: "LB",
    });
  });

  it("rejects invalid numbers with the offending paths", () => {
    const f = shippingSettingsToForm(shippingDefaults);
    f["rate.IL.M"] = "-1";
    f.divisor = "abc";
    const res = shippingSettingsFromForm(f, shippingDefaults, NOW);
    expect(res).toMatchObject({ ok: false, code: "INVALID_SETTINGS" });
    expect(!res.ok && res.details).toContain("classRatesIls.IL.M");
  });

  it("drops an empty cap (no cap for that carrier)", () => {
    const f = shippingSettingsToForm(shippingDefaults);
    f["cap.DHL"] = "";
    const res = shippingSettingsFromForm(f, shippingDefaults, NOW);
    expect(res.ok && res.value.valueCaps.some((c) => c.carrier === "DHL")).toBe(
      false,
    );
  });
});
