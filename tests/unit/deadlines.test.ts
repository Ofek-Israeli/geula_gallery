import { describe, expect, it } from "vitest";
import {
  CHANGE_OF_MIND_FEE_CAP_ILS_MINOR,
  cancellationWindow,
  changeOfMindFee,
  isWithinWindow,
  refundDueAt,
  windowLength,
} from "@/lib/deadlines";
import { jerusalemWallClock } from "@/lib/format";

const at = (iso: string) => new Date(iso);

function wall(d: Date | null) {
  if (!d) return null;
  const w = jerusalemWallClock(d);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.second).padStart(2, "0")}`;
}

describe("cancellationWindow (spec §5.7 step 6)", () => {
  it("starts at delivery when the disclosure was sent earlier", () => {
    const w = cancellationWindow({
      deliveredAt: at("2026-10-05T10:00:00Z"),
      disclosureSentAt: at("2026-10-01T10:00:00Z"),
      eligibleGroup: "NONE",
      conversationTookPlace: false,
    });
    expect(w.length).toBe("14_DAYS");
    expect(w.beforeDelivery).toBe(false);
    expect(w.start?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    // 14 Jerusalem calendar days later, to the end of that day.
    expect(wall(w.end)).toBe("2026-10-19 23:59:59");
  });

  it("starts at the later disclosure when it came after delivery", () => {
    const w = cancellationWindow({
      deliveredAt: at("2026-10-05T10:00:00Z"),
      disclosureSentAt: at("2026-10-08T07:00:00Z"),
      eligibleGroup: "NONE",
      conversationTookPlace: false,
    });
    expect(w.start?.toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(wall(w.end)).toBe("2026-10-22 23:59:59");
  });

  it("uses delivery when no disclosure was sent", () => {
    const w = cancellationWindow({
      deliveredAt: at("2026-10-05T10:00:00Z"),
      disclosureSentAt: null,
      eligibleGroup: "NONE",
      conversationTookPlace: true,
    });
    expect(w.start?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });

  it("has no start before delivery, and a notice then is still valid", () => {
    const w = cancellationWindow({
      deliveredAt: null,
      disclosureSentAt: at("2026-10-01T10:00:00Z"),
      eligibleGroup: "SENIOR_65",
      conversationTookPlace: true,
    });
    expect(w).toEqual({
      start: null,
      end: null,
      length: "4_MONTHS",
      beforeDelivery: true,
    });
    expect(isWithinWindow(w, at("2030-01-01T00:00:00Z"))).toBe(true);
  });

  it("gives 4 months only with eligibility AND a conversation", () => {
    expect(windowLength("NONE", true)).toBe("14_DAYS");
    expect(windowLength("DISABILITY", false)).toBe("14_DAYS");
    expect(windowLength("NEW_IMMIGRANT", true)).toBe("4_MONTHS");
    const w = cancellationWindow({
      deliveredAt: at("2026-10-31T10:00:00Z"),
      disclosureSentAt: null,
      eligibleGroup: "SENIOR_65",
      conversationTookPlace: true,
    });
    expect(w.length).toBe("4_MONTHS");
    // 31 October + 4 months → clamped to 28 February 2027.
    expect(wall(w.end)).toBe("2027-02-28 23:59:59");
  });

  it("crosses the October DST change on calendar days", () => {
    // Israel leaves summer time on 2026-10-25.
    const w = cancellationWindow({
      deliveredAt: at("2026-10-20T21:30:00Z"), // 21 Oct 00:30 IDT
      disclosureSentAt: null,
      eligibleGroup: "NONE",
      conversationTookPlace: false,
    });
    expect(wall(w.end)).toBe("2026-11-04 23:59:59");
    expect(w.end?.toISOString()).toBe("2026-11-04T21:59:59.000Z");
  });

  it("isWithinWindow compares with the end of the last day", () => {
    const w = cancellationWindow({
      deliveredAt: at("2026-10-05T10:00:00Z"),
      disclosureSentAt: null,
      eligibleGroup: "NONE",
      conversationTookPlace: false,
    });
    expect(isWithinWindow(w, at("2026-10-19T20:59:00Z"))).toBe(true);
    expect(isWithinWindow(w, at("2026-10-19T21:00:01Z"))).toBe(false);
  });
});

describe("refundDueAt (from the notice)", () => {
  it("is 14 Jerusalem calendar days after the notice, same wall-clock time", () => {
    const d = refundDueAt(at("2026-10-01T09:15:00Z"));
    expect(d.toISOString()).toBe("2026-10-15T09:15:00.000Z");
  });

  it("keeps the wall-clock time across the DST change", () => {
    // 20 Oct 12:00 IDT (UTC+3) → 3 Nov 12:00 IST (UTC+2).
    const d = refundDueAt(at("2026-10-20T09:00:00Z"));
    expect(wall(d)).toBe("2026-11-03 12:00:00");
    expect(d.toISOString()).toBe("2026-11-03T10:00:00.000Z");
  });
});

describe("changeOfMindFee", () => {
  const base = {
    regime: "IL" as const,
    reason: "CHANGE_OF_MIND" as const,
    currency: "ILS" as const,
    policy: "STATUTORY_MAX" as const,
  };

  it("is 5% below the cap", () => {
    expect(changeOfMindFee({ ...base, totalPaidMinor: 150_000 })).toEqual({
      feeMinor: 7_500,
      currency: "ILS",
    });
  });

  it("is capped at ₪100", () => {
    expect(
      changeOfMindFee({ ...base, totalPaidMinor: 2_000_000 }).feeMinor,
    ).toBe(CHANGE_OF_MIND_FEE_CAP_ILS_MINOR);
  });

  it("rounds the percentage to the agora", () => {
    expect(changeOfMindFee({ ...base, totalPaidMinor: 1_001 }).feeMinor).toBe(
      50,
    );
  });

  it("is 0 for the EU regime, a defect, or the NONE policy", () => {
    expect(
      changeOfMindFee({ ...base, regime: "EU", totalPaidMinor: 150_000 })
        .feeMinor,
    ).toBe(0);
    expect(
      changeOfMindFee({ ...base, reason: "DEFECT", totalPaidMinor: 150_000 })
        .feeMinor,
    ).toBe(0);
    expect(
      changeOfMindFee({ ...base, policy: "NONE", totalPaidMinor: 150_000 })
        .feeMinor,
    ).toBe(0);
  });

  it("converts the cap to USD with the locked rate (rounded down)", () => {
    // $2,800 × 5% = $140 > ₪100 / 3.7 = $27.02.
    expect(
      changeOfMindFee({
        ...base,
        currency: "USD",
        totalPaidMinor: 280_000,
        ilsPerUsd: 3.7,
      }),
    ).toEqual({ feeMinor: 2_702, currency: "USD" });
    // $400 × 5% = $20 < $27.02.
    expect(
      changeOfMindFee({
        ...base,
        currency: "USD",
        totalPaidMinor: 40_000,
        ilsPerUsd: 3.7,
      }).feeMinor,
    ).toBe(2_000);
  });

  it("refuses a USD fee without a rate", () => {
    expect(() =>
      changeOfMindFee({ ...base, currency: "USD", totalPaidMinor: 40_000 }),
    ).toThrow(RangeError);
  });
});
