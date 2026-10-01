import { describe, expect, it } from "vitest";
import {
  adminLoginPath,
  checkAdminSession,
  FRESH_SESSION_MAX_AGE_MS,
  safeAdminNext,
} from "@/server/auth/policy";

const now = Date.parse("2026-10-01T10:00:00Z");
const session = (createdAgoMs: number, twoFactorEnabled: boolean) => ({
  session: { createdAt: new Date(now - createdAgoMs) },
  user: { twoFactorEnabled },
});

describe("checkAdminSession", () => {
  it("requires a session", () => {
    expect(checkAdminSession(null, { require2fa: false })).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("sends unenrolled admins to enroll-2fa only when 2FA is required", () => {
    expect(checkAdminSession(session(0, false), { require2fa: true }).ok).toBe(
      false,
    );
    expect(
      checkAdminSession(session(0, false), { require2fa: true }),
    ).toMatchObject({
      reason: "enroll-2fa",
    });
    expect(
      checkAdminSession(session(0, false), {
        require2fa: true,
        allowUnenrolled: true,
      }).ok,
    ).toBe(true);
    expect(checkAdminSession(session(0, false), { require2fa: false }).ok).toBe(
      true,
    );
    expect(checkAdminSession(session(0, true), { require2fa: true }).ok).toBe(
      true,
    );
  });

  it("enforces fresh sessions (≤ 30 min)", () => {
    const fresh = { require2fa: false, fresh: true, now };
    expect(
      checkAdminSession(session(FRESH_SESSION_MAX_AGE_MS, true), fresh).ok,
    ).toBe(true);
    expect(
      checkAdminSession(session(FRESH_SESSION_MAX_AGE_MS + 1, true), fresh),
    ).toMatchObject({
      reason: "stale",
    });
  });
});

describe("safeAdminNext", () => {
  it("allows same-site admin paths only", () => {
    expect(safeAdminNext("he", "/he/admin/orders?x=1")).toBe(
      "/he/admin/orders?x=1",
    );
    expect(safeAdminNext("en", "/he/print/admin/packing-slip/1")).toBe(
      "/he/print/admin/packing-slip/1",
    );
    for (const bad of [
      null,
      "",
      "https://evil.example/he/admin",
      "//evil.example/he/admin",
      "/he/admin//evil.example",
      "/he/admin\\evil",
      "/he/works",
      "/he/admin/login",
      "/he/admin/login/2fa",
      "/he/administrator",
    ]) {
      expect(safeAdminNext("he", bad)).toBe("/he/admin");
    }
  });

  it("builds login paths", () => {
    expect(adminLoginPath("he")).toBe("/he/admin/login");
    expect(adminLoginPath("en", { next: "/en/admin", reauth: true })).toBe(
      "/en/admin/login?next=%2Fen%2Fadmin&reauth=1",
    );
  });
});
