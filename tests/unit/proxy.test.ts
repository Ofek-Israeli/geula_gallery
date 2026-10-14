import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import proxy from "@/proxy";

/**
 * `src/proxy.ts`: the Isracard pay page gets a fresh nonce CSP on the response and the same
 * nonce as a forwarded request header (Next applies it to its scripts; the page to PayMe's);
 * other pages keep the static policy from `next.config.ts` (the proxy adds none).
 */
const PAY =
  "http://localhost/he/checkout/pay/0d4f7a52-6a1e-4c1e-9b8e-0f6f6e6b8a11?t=x";

function nonceOf(csp: string | null): string | null {
  return /'nonce-([^']+)'/.exec(csp ?? "")?.[1] ?? null;
}

describe("proxy", () => {
  it("gives the pay page a per-request nonce CSP, forwarded to the render", () => {
    const res = proxy(new NextRequest(PAY));
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceOf(csp);
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-src https://hf.payme.io");
    // NextResponse.next({ request: { headers } }) carries the overridden request headers.
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(
      nonceOf(res.headers.get("x-middleware-request-content-security-policy")),
    ).toBe(nonce);
    // A new nonce every time.
    expect(
      nonceOf(
        proxy(new NextRequest(PAY)).headers.get("content-security-policy"),
      ),
    ).not.toBe(nonce);
  });

  it("adds no CSP to other pages (the static policy comes from next.config.ts)", () => {
    for (const url of [
      "http://localhost/he/works",
      "http://localhost/en/checkout/the-path",
    ]) {
      const res = proxy(new NextRequest(url));
      expect(res.headers.get("content-security-policy"), url).toBeNull();
      expect(res.headers.get("x-middleware-request-x-nonce"), url).toBeNull();
    }
  });
});
