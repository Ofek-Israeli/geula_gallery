import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  heldOrder,
  startTestCheckout,
} from "../helpers/factories/commerce";
import { uniqueBuyer } from "../helpers/factories/core";

/**
 * Commerce limits at their production values (spec §3.5 "Anti-hoarding", §7 "Abuse", §10.3
 * `limits`): the integration environment runs with `RATE_LIMIT_SCALE=1`, exactly like production,
 * so every limit below is the real number a buyer meets.
 */
const { db } = await import("@/server/db/client");
const { LIMITS } = await import("@/server/security/limits");
const { checkLimit } = await import("@/server/security/rate-limit");
const { getSetting } = await import("@/server/settings");
const { handlePaymentReturn } = await import("@/server/payments/webhook");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { startPaymentForOrder } = await import("@/server/checkout/start");
const { env } = await import("@/server/env");

cleanDatabaseBeforeEach();

async function exhaust(
  name: keyof typeof LIMITS,
  subject: string,
  n: number,
  now?: Date,
) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await checkLimit(name, subject, now ? { now } : {}));
  }
  return results;
}

describe("rate limits (scale 1 = production)", () => {
  it("runs with the production scale", () => {
    expect(env.RATE_LIMIT_SCALE).toBe(1);
  });

  it("has the spec §7 values", () => {
    expect(LIMITS).toMatchObject({
      checkoutIp: { limit: 10, windowSec: 600 },
      checkoutEmail: { limit: 5, windowSec: 3600 },
      returnIp: { limit: 60, windowSec: 60 },
      webhookAuthFailureIp: { limit: 30, windowSec: 60 },
      paypalPreverifyIp: { limit: 60, windowSec: 60 },
      badOrderKeyIp: { limit: 30, windowSec: 60 },
    });
  });

  it("checkout: the 11th start from one IP in 10 minutes is refused; the next window is open", async () => {
    const t0 = new Date("2026-10-01T10:00:00Z");
    const first = await exhaust("checkoutIp", "ip-hash-a", 11, t0);
    expect(first.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(first[10]?.allowed).toBe(false);
    expect(first[10]?.retryAfterSec).toBe(600);
    const later = await checkLimit("checkoutIp", "ip-hash-a", {
      now: new Date(t0.getTime() + 600_000),
    });
    expect(later.allowed).toBe(true);
    // Other IPs are unaffected.
    expect(
      (await checkLimit("checkoutIp", "ip-hash-b", { now: t0 })).allowed,
    ).toBe(true);
  });

  it("checkout: the 6th start for one email in an hour is refused, whatever its case", async () => {
    const email = uniqueBuyer().email;
    const runs = [
      ...(await exhaust("checkoutEmail", email, 3)),
      ...(await exhaust("checkoutEmail", email.toUpperCase(), 3)),
    ];
    expect(runs.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(runs[5]?.allowed).toBe(false);
  });

  it("the payment return route answers 429 after 60 requests a minute from one IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const r = await handlePaymentReturn({
        provider: "mock",
        query: new URLSearchParams({ a: "x", r: "y", l: "en" }),
        ip: "203.0.113.77",
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 303)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("bad order tokens: 30 a minute per IP", async () => {
    const runs = await exhaust("badOrderKeyIp", "ip-hash-k", 31);
    expect(runs[29]?.allowed).toBe(true);
    expect(runs[30]?.allowed).toBe(false);
  });
});

describe("anti-hoarding and attempt caps (settings defaults)", () => {
  it("has the spec §3.5 defaults", async () => {
    const s = await getSetting("checkout", db);
    expect(s).toMatchObject({
      reservationMinutes: 35,
      linkHoursDefault: 48,
      maxActiveHoldsPerEmail: 2,
      maxActiveHoldsPerIp: 3,
      maxHoldsPerArtworkPerBuyer24h: 2,
      holdCooldownMinutes: 15,
      maxHoldCountPerOrder: 3,
      maxWebHoldSpanMinutes: 120,
      maxAttemptsPerOrder: 5,
    });
  });

  it("a third live web hold for one email is refused", async () => {
    const buyer = { ...uniqueBuyer(), phone: "+97230000000" };
    for (let i = 0; i < 2; i++) {
      const art = await buyableArtwork(db);
      await heldOrder(art.slug, { buyer, ipHash: `ip-${i}` });
    }
    const third = await buyableArtwork(db);
    const { result } = await startTestCheckout(third.slug, {
      buyer,
      ipHash: "ip-3",
    });
    expect(result).toEqual({ kind: "refused", code: "too_many_holds" });
  });

  it("a fourth live web hold from one IP is refused", async () => {
    for (let i = 0; i < 3; i++) {
      const art = await buyableArtwork(db);
      await heldOrder(art.slug, { ipHash: "ip-shared" });
    }
    const fourth = await buyableArtwork(db);
    const { result } = await startTestCheckout(fourth.slug, {
      ipHash: "ip-shared",
    });
    expect(result).toEqual({ kind: "refused", code: "too_many_holds" });
  });

  it("an order takes at most 5 payment attempts", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "cancel");
    await finalizeAttempt(h.attemptId, { trigger: "return" });
    for (let seq = 2; seq <= 5; seq++) {
      const { result } = await startPaymentForOrder({
        orderId: h.orderId,
        providerId: "mock",
        locale: "en",
        ipHash: h.input.ipHash,
      });
      expect(result.kind).toBe("redirect");
    }
    const sixth = await startPaymentForOrder({
      orderId: h.orderId,
      providerId: "mock",
      locale: "en",
      ipHash: h.input.ipHash,
    });
    expect(sixth.result).toEqual({
      kind: "refused",
      code: "too_many_attempts",
    });
  });
});
