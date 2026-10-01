import { describe, expect, it } from "vitest";
import {
  addJerusalemDays,
  addJerusalemMonths,
  endOfJerusalemDay,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  fromJerusalemWallClock,
  jerusalemDateKey,
  jerusalemOffsetMinutes,
  jerusalemWallClock,
  startOfJerusalemDay,
  stripBidi,
} from "@/lib/format";

const at = (iso: string) => new Date(iso);

describe("display formatting (Asia/Jerusalem)", () => {
  it("formats dates and times in Jerusalem", () => {
    const d = at("2026-10-01T09:05:00Z"); // 12:05 summer time
    expect(stripBidi(formatDate(d, "en"))).toBe("1 October 2026");
    expect(stripBidi(formatDate(d, "he"))).toBe("1 באוקטובר 2026");
    expect(stripBidi(formatDate(d, "en", "short"))).toBe("01/10/2026");
    expect(formatTime(d, "en")).toBe("12:05");
    expect(formatTime(at("2026-12-01T22:30:00Z"), "he")).toBe("00:30");
    expect(stripBidi(formatDateTime(d, "en"))).toBe("1 October 2026, 12:05");
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
  });

  it("strips bidi marks and non-breaking spaces", () => {
    expect(stripBidi("‏1,200 ₪‎ ")).toBe("1,200 ₪ ");
  });

  it("rejects invalid dates", () => {
    expect(() => formatDate("nope", "en")).toThrow(RangeError);
  });
});

describe("Jerusalem calendar arithmetic", () => {
  it("knows the offset in summer and winter", () => {
    expect(jerusalemOffsetMinutes(at("2026-07-01T12:00:00Z"))).toBe(180);
    expect(jerusalemOffsetMinutes(at("2026-12-01T12:00:00Z"))).toBe(120);
  });

  it("uses the Israeli calendar day", () => {
    expect(jerusalemDateKey(at("2026-10-01T21:30:00Z"))).toBe("2026-10-02");
    expect(jerusalemWallClock(at("2026-10-01T21:30:00Z"))).toEqual({
      year: 2026,
      month: 10,
      day: 2,
      hour: 0,
      minute: 30,
      second: 0,
    });
  });

  it("adds calendar days across the autumn DST change (25 Oct 2026)", () => {
    const start = at("2026-10-20T07:00:00Z"); // 10:00 IDT
    const end = addJerusalemDays(start, 14);
    expect(end.toISOString()).toBe("2026-11-03T08:00:00.000Z"); // 10:00 IST
    expect(end.getTime() - start.getTime()).toBe((14 * 24 + 1) * 3_600_000);
  });

  it("adds calendar days across the spring DST change (26 Mar 2027)", () => {
    const start = at("2027-03-20T08:00:00Z"); // 10:00 IST
    expect(addJerusalemDays(start, 14).toISOString()).toBe(
      "2027-04-03T07:00:00.000Z",
    ); // 10:00 IDT
  });

  it("adds months, clamping the day", () => {
    expect(
      jerusalemDateKey(addJerusalemMonths(at("2027-01-31T10:00:00Z"), 1)),
    ).toBe("2027-02-28");
    expect(
      jerusalemDateKey(addJerusalemMonths(at("2026-10-01T10:00:00Z"), 4)),
    ).toBe("2027-02-01");
  });

  it("resolves DST gaps forward and overlaps to the earlier instant", () => {
    // 02:30 on 26 Mar 2027 does not exist (02:00 → 03:00): resolves to 03:30 IDT.
    const gap = fromJerusalemWallClock({
      year: 2027,
      month: 3,
      day: 26,
      hour: 2,
      minute: 30,
      second: 0,
    });
    expect(gap.toISOString()).toBe("2027-03-26T00:30:00.000Z");
    // 01:30 on 25 Oct 2026 happens twice: the earlier (IDT) instant wins.
    const overlap = fromJerusalemWallClock({
      year: 2026,
      month: 10,
      day: 25,
      hour: 1,
      minute: 30,
      second: 0,
    });
    expect(overlap.toISOString()).toBe("2026-10-24T22:30:00.000Z");
  });

  it("finds the start and end of an Israeli day", () => {
    const d = at("2026-10-01T12:00:00Z");
    expect(startOfJerusalemDay(d).toISOString()).toBe(
      "2026-09-30T21:00:00.000Z",
    );
    expect(endOfJerusalemDay(d).toISOString()).toBe("2026-10-01T20:59:59.000Z");
  });
});
