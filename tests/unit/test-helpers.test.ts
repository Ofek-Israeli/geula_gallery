import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ORDER_NUMBER_RE } from "@/lib/validation/identifiers";
import {
  MOCK_SIGNATURE_HEADER as APP_HEADER,
  MOCK_SIGNATURE_TOLERANCE_SEC,
} from "@/server/payments/providers/mock";
import { testOrderNumber, uniqueBuyer } from "../helpers/factories/core";
import {
  buildMockWebhook,
  MOCK_SIGNATURE_HEADER,
  signMockWebhook,
} from "../helpers/mock-webhook";
import { createBarrier } from "../helpers/race";
import {
  base32Decode,
  base32Encode,
  secretFromTotpUri,
  totp,
} from "../helpers/totp";

/** The frozen test helpers (spec §9.3) agree with the app and the RFCs they implement. */
describe("totp helper", () => {
  // RFC 6238 appendix B, SHA-1 seed "12345678901234567890".
  const seed = base32Encode(Buffer.from("12345678901234567890"));
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("matches the RFC 6238 vector at t=%i", (t, code) => {
    expect(totp(seed, { at: t * 1000, digits: 8 })).toBe(code);
  });

  it("round-trips base32 and reads otpauth URIs", () => {
    expect(base32Decode(seed).toString()).toBe("12345678901234567890");
    expect(
      secretFromTotpUri(
        `otpauth://totp/Geula:painter%40example.test?secret=${seed}&issuer=Geula`,
      ),
    ).toBe(seed);
  });
});

describe("mock webhook helper", () => {
  it("uses the provider's header and the spec signature scheme", () => {
    expect(MOCK_SIGNATURE_HEADER).toBe(APP_HEADER);
    expect(MOCK_SIGNATURE_TOLERANCE_SEC).toBe(300);
    const body = '{"id":"evt_1","type":"payment.updated","ref":"r1"}';
    const expected = createHmac("sha256", "test-secret")
      .update(`1700000000.${body}`)
      .digest("hex");
    expect(signMockWebhook(body, "test-secret", 1700000000)).toBe(
      `t=1700000000,v1=${expected}`,
    );
  });

  it("builds forged and unsigned variants", () => {
    const base = {
      baseUrl: "http://localhost:3100/",
      ref: "mock_1",
      secret: "test-secret",
    };
    const ok = buildMockWebhook(base);
    expect(ok.url).toBe("http://localhost:3100/api/payments/mock/webhook");
    expect(JSON.parse(ok.body)).toMatchObject({
      type: "payment.updated",
      ref: "mock_1",
    });
    expect(
      buildMockWebhook({ ...base, unsigned: true }).headers,
    ).not.toHaveProperty(MOCK_SIGNATURE_HEADER);
    expect(
      buildMockWebhook({ ...base, signWith: "wrong" }).headers[
        MOCK_SIGNATURE_HEADER
      ],
    ).not.toBe(ok.headers[MOCK_SIGNATURE_HEADER]);
  });
});

describe("core factories and race barrier", () => {
  it("makes unique allowlisted buyers and valid order numbers", () => {
    const a = uniqueBuyer();
    const b = uniqueBuyer();
    expect(a.email).not.toBe(b.email);
    expect(a.email).toMatch(/@example\.test$/);
    expect(a.phone).toBe("+972-3-000-0000");
    expect(testOrderNumber()).toMatch(ORDER_NUMBER_RE);
  });

  it("releases all parties together", async () => {
    const barrier = createBarrier(3);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await new Promise((r) => setTimeout(r, i * 5));
        await barrier.wait();
        order.push(i);
      }),
    );
    expect(order.sort()).toEqual([0, 1, 2]);
  });
});
