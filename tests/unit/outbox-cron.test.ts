import { describe, expect, it } from "vitest";
import {
  backoffMs,
  dedupeKeys,
  JOB_KINDS,
  jobPayloadSchemas,
  MAX_ATTEMPTS,
} from "@/server/outbox/types";
import { cronMatches, parseCron } from "../../scripts/lib/cron-schedule";

const MIN = 60_000;

describe("outbox policy", () => {
  it("backs off min(2^attempts min, 6 h)", () => {
    expect(backoffMs(1)).toBe(2 * MIN);
    expect(backoffMs(2)).toBe(4 * MIN);
    expect(backoffMs(5)).toBe(32 * MIN);
    expect(backoffMs(8)).toBe(256 * MIN);
    expect(backoffMs(9)).toBe(360 * MIN);
    expect(backoffMs(30)).toBe(360 * MIN);
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it("has the five job kinds with id-only payload schemas", () => {
    expect(JOB_KINDS).toEqual([
      "SEND_EMAIL",
      "ISSUE_TAX_DOCUMENT",
      "ISSUE_CREDIT_NOTE",
      "REFUND_PAYMENT",
      "REFUND_SETTLED",
    ]);
    expect(
      jobPayloadSchemas.REFUND_PAYMENT.safeParse({ refundId: "nope" }).success,
    ).toBe(false);
    expect(
      jobPayloadSchemas.SEND_EMAIL.safeParse({
        template: "receipt",
        to: "a@example.test",
        locale: "he",
        refId: "x",
      }).success,
    ).toBe(true);
    expect(
      jobPayloadSchemas.SEND_EMAIL.safeParse({
        template: "newsletter",
        to: "a@example.test",
        locale: "he",
        refId: "x",
      }).success,
    ).toBe(false);
  });

  it("builds canonical dedupe keys", () => {
    expect(dedupeKeys.email("receipt", "o1", " A@Example.TEST ")).toBe(
      "email:receipt:o1:a@example.test",
    );
    expect(dedupeKeys.receipt("a1")).toBe("taxdoc:receipt:a1");
    expect(dedupeKeys.refund("r1")).toBe("refund:r1");
    expect(dedupeKeys.refundSettled("r1")).toBe("refund-settled:r1");
  });
});

describe("cron schedule matcher (scripts/cron.ts --watch)", () => {
  const at = (iso: string) => new Date(iso);

  it("matches the vercel.json schedules in UTC", () => {
    const every5 = parseCron("*/5 * * * *");
    expect(cronMatches(every5, at("2026-10-01T10:05:00Z"))).toBe(true);
    expect(cronMatches(every5, at("2026-10-01T10:06:00Z"))).toBe(false);
    const hourly = parseCron("0 * * * *");
    expect(cronMatches(hourly, at("2026-10-01T23:00:00Z"))).toBe(true);
    expect(cronMatches(hourly, at("2026-10-01T23:30:00Z"))).toBe(false);
    const daily = parseCron("0 5 * * *");
    expect(cronMatches(daily, at("2026-10-01T05:00:00Z"))).toBe(true);
    expect(cronMatches(daily, at("2026-10-01T08:00:00+03:00"))).toBe(true);
    const purge = parseCron("30 2 * * *");
    expect(cronMatches(purge, at("2026-10-01T02:30:00Z"))).toBe(true);
  });

  it("supports lists, ranges, steps and POSIX day-field semantics", () => {
    const s = parseCron("0,30 9-17/2 * * 1-5");
    expect(cronMatches(s, at("2026-10-01T11:30:00Z"))).toBe(true); // Thu
    expect(cronMatches(s, at("2026-10-01T10:30:00Z"))).toBe(false);
    expect(cronMatches(s, at("2026-10-04T11:30:00Z"))).toBe(false); // Sun
    const either = parseCron("0 0 1 * 0");
    expect(cronMatches(either, at("2026-10-01T00:00:00Z"))).toBe(true); // 1st
    expect(cronMatches(either, at("2026-10-04T00:00:00Z"))).toBe(true); // Sun
    expect(cronMatches(either, at("2026-10-05T00:00:00Z"))).toBe(false);
    expect(
      cronMatches(parseCron("0 0 * * 7"), at("2026-10-04T00:00:00Z")),
    ).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
    expect(() => parseCron("5-1 * * * *")).toThrow();
  });
});
