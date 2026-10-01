import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  env: {
    APP_SECRET: "test-app-secret-at-least-32-characters-long",
    PII_ENCRYPTION_KEY_BYTES: Buffer.alloc(32, 7),
    RATE_LIMIT_SCALE: 1,
    isProduction: false,
  },
}));

const crypto = await import("@/server/security/crypto");
const tokens = await import("@/server/security/tokens");
const redact = await import("@/server/security/redact");
const limits = await import("@/server/security/limits");
const ip = await import("@/server/security/ip");

describe("crypto", () => {
  it("derives distinct keys per purpose", () => {
    const a = crypto.deriveKey("secret", "return");
    const b = crypto.deriveKey("secret", "cardcom-notify");
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    expect(crypto.deriveKey("secret", "return").equals(a)).toBe(true);
  });

  it("compares strings safely", () => {
    expect(crypto.safeEqual("abc", "abc")).toBe(true);
    expect(crypto.safeEqual("abc", "abd")).toBe(false);
    expect(crypto.safeEqual("abc", "abcd")).toBe(false);
  });

  it("round-trips AES-256-GCM and rejects tampering or a wrong AAD", () => {
    const key = Buffer.alloc(32, 1);
    const ct = crypto.encryptAesGcm(key, "000000018", "cancellations:1");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(ct).not.toContain("000000018");
    expect(crypto.decryptAesGcm(key, ct, "cancellations:1")).toBe("000000018");
    expect(() => crypto.decryptAesGcm(key, ct, "cancellations:2")).toThrow();
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() =>
      crypto.decryptAesGcm(key, parts.join("."), "cancellations:1"),
    ).toThrow();
  });
});

describe("tokens", () => {
  it("hmac tokens are 32 chars, deterministic and purpose-bound", () => {
    const t = tokens.hmacToken("return", "attempt-1");
    expect(t).toHaveLength(32);
    expect(tokens.hmacToken("return", "attempt-1")).toBe(t);
    expect(tokens.hmacToken("cardcom-notify", "attempt-1")).not.toBe(t);
    expect(tokens.verifyHmacToken("return", "attempt-1", t)).toBe(true);
    expect(tokens.verifyHmacToken("return", "attempt-2", t)).toBe(false);
    expect(tokens.verifyHmacToken("return", "attempt-1", null)).toBe(false);
  });

  it("order access tokens are revoked by bumping accessVersion", () => {
    const k = tokens.orderAccessToken("order-1", 1);
    expect(tokens.verifyOrderAccessToken("order-1", 1, k)).toBe(true);
    expect(tokens.verifyOrderAccessToken("order-1", 2, k)).toBe(false);
  });

  it("signed tokens expire and reject forgery", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    const t = tokens.signToken("file-url", { key: "private/a.pdf" }, 600, now);
    expect(tokens.verifySignedToken("file-url", t, now)?.key).toBe(
      "private/a.pdf",
    );
    expect(tokens.verifySignedToken("cancel-review", t, now)).toBeNull();
    expect(
      tokens.verifySignedToken(
        "file-url",
        t,
        new Date(now.getTime() + 601_000),
      ),
    ).toBeNull();
    const [body] = t.split(".");
    expect(
      tokens.verifySignedToken("file-url", `${body}.forged`, now),
    ).toBeNull();
  });

  it("measures form age from a signed start token", () => {
    const start = new Date("2026-10-01T10:00:00Z");
    const token = tokens.issueFormStartToken(start);
    expect(tokens.formAgeMs(token, new Date(start.getTime() + 4000))).toBe(
      4000,
    );
    expect(tokens.formAgeMs("garbage", start)).toBeNull();
    expect(tokens.formAgeMs(undefined, start)).toBeNull();
  });
});

describe("redact", () => {
  it("redacts sensitive keys deeply and keeps safe ones", () => {
    const out = redact.redact({
      password: "x",
      nested: {
        ApiName: "y",
        apiKey: "z",
        cardLast4: "4242",
        list: [{ token: "t" }],
      },
      amount: 100,
    });
    expect(out).toEqual({
      password: redact.REDACTED,
      nested: {
        ApiName: redact.REDACTED,
        apiKey: redact.REDACTED,
        cardLast4: "4242",
        list: [{ token: redact.REDACTED }],
      },
      amount: 100,
    });
  });

  it("masks emails, ID numbers and phones", () => {
    expect(redact.maskEmail("painter@example.com")).toBe("p*****r@example.com");
    expect(redact.maskEmail("ab@example.com")).toBe("a*@example.com");
    expect(redact.maskIdNumber("000000018")).toBe("*******18");
    expect(redact.maskPhone("+972-3-000-0000")).toBe("********000");
  });
});

describe("limits", () => {
  it("scales limits and refuses a non-1 scale in production", () => {
    expect(limits.scaledLimit(5, 1, false)).toBe(5);
    expect(limits.scaledLimit(5, 100, false)).toBe(500);
    expect(limits.scaledLimit(5, 0.01, false)).toBe(1);
    expect(limits.scaledLimit(5, 1, true)).toBe(5);
    expect(() => limits.scaledLimit(5, 100, true)).toThrow(
      limits.RateLimitScaleError,
    );
  });

  it("matches the spec §7 table", () => {
    expect(limits.LIMITS.checkoutIp).toEqual({ limit: 10, windowSec: 600 });
    expect(limits.LIMITS.checkoutEmail).toEqual({ limit: 5, windowSec: 3600 });
    expect(limits.LIMITS.cancellationIp).toEqual({
      limit: 20,
      windowSec: 3600,
    });
    expect(limits.LIMITS.badOrderKeyIp).toEqual({ limit: 30, windowSec: 60 });
  });
});

describe("ip", () => {
  it("reads the client IP and hashes it", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(ip.clientIp(h)).toBe("203.0.113.5");
    expect(ip.clientIp(new Headers({ "x-real-ip": "198.51.100.7" }))).toBe(
      "198.51.100.7",
    );
    expect(ip.clientIp(new Headers())).toBeNull();
    const hash = ip.ipHashFrom(h);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain("203");
  });
});
