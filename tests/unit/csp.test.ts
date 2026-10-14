import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { afterEach, describe, expect, it } from "vitest";
import {
  CARD_PAGE_PATH,
  cardPageCsp,
  PAY_PAGE_PATH,
  PAYME_HOSTS,
  payPageCsp,
  STATIC_CSP_SOURCE,
} from "@/lib/csp";
import nextConfig from "../../next.config";

/** Static security headers (spec §7 "Headers", §10.1 `csp`). */

type Header = { key: string; value: string };

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

async function globalHeaders(
  phase: string,
  env: Record<string, string>,
): Promise<Map<string, string>> {
  Object.assign(process.env, env);
  const config = nextConfig(phase);
  const rules = (await config.headers?.()) ?? [];
  const all = rules.find((r) => r.source === "/:path*");
  if (!all) throw new Error("no global /:path* header rule");
  // The static CSP has its own rule: every path except the pay page.
  const csp = rules.find((r) => r.source === STATIC_CSP_SOURCE);
  if (!csp) throw new Error("no static CSP rule");
  return new Map(
    [...(all.headers as Header[]), ...(csp.headers as Header[])].map((h) => [
      h.key.toLowerCase(),
      h.value,
    ]),
  );
}

function directives(csp: string | undefined): Map<string, string> {
  expect(csp).toBeTruthy();
  return new Map(
    (csp ?? "").split(";").map((d) => {
      const [name = "", ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")];
    }),
  );
}

describe("csp", () => {
  it("production build: strict static policy with provider form-action only", async () => {
    const h = await globalHeaders(PHASE_PRODUCTION_BUILD, {
      APP_ENV: "production",
      DEMO_MODE: "false",
    });
    const d = directives(h.get("content-security-policy"));
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).toBe("'self' 'unsafe-inline'");
    expect(d.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(d.get("img-src")).toBe(
      "'self' data: blob: https://*.public.blob.vercel-storage.com",
    );
    expect(d.get("font-src")).toBe("'self'");
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("frame-src")).toBe("'none'");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'self'");
    expect(d.get("form-action")).toBe(
      "'self' https://secure.cardcom.solutions https://www.paypal.com https://www.sandbox.paypal.com",
    );
    expect(d.has("upgrade-insecure-requests")).toBe(true);
    expect(h.get("content-security-policy")).not.toContain("unsafe-eval");

    expect(h.get("strict-transport-security")).toContain("max-age=");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("permissions-policy")).toContain("camera=()");
    expect(h.has("x-robots-tag")).toBe(false);
    expect(nextConfig(PHASE_PRODUCTION_BUILD).poweredByHeader).toBe(false);
  });

  it("development server: unsafe-eval and ws: only in dev, no HSTS", async () => {
    const h = await globalHeaders(PHASE_DEVELOPMENT_SERVER, {
      APP_ENV: "development",
      DEMO_MODE: "true",
    });
    const d = directives(h.get("content-security-policy"));
    expect(d.get("script-src")).toBe("'self' 'unsafe-inline' 'unsafe-eval'");
    expect(d.get("connect-src")).toBe("'self' ws:");
    expect(d.has("upgrade-insecure-requests")).toBe(false);
    expect(h.has("strict-transport-security")).toBe(false);
    // §6.9: demo mode is noindex everywhere.
    expect(h.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("the static CSP covers every path but the Isracard pay page", async () => {
    const matches = getPathMatch(STATIC_CSP_SOURCE);
    for (const path of [
      "/he",
      "/en/works/the-path",
      "/he/checkout/the-path",
      "/en/checkout",
      "/he/orders/GG-ABC123",
      "/api/payments/isracard/webhook",
    ]) {
      expect(matches(path), path).not.toBe(false);
    }
    for (const path of [
      "/he/checkout/pay/0d4f7a52-6a1e-4c1e-9b8e-0f6f6e6b8a11",
      "/en/checkout/pay/0d4f7a52-6a1e-4c1e-9b8e-0f6f6e6b8a11",
      "/he/checkout/pay/card",
      "/en/checkout/pay/card",
    ]) {
      expect(matches(path), path).toBe(false);
      expect(PAY_PAGE_PATH.test(path), path).toBe(true);
    }
    expect(PAY_PAGE_PATH.test("/he/checkout/the-path")).toBe(false);
    expect(CARD_PAGE_PATH.test("/he/checkout/pay/card")).toBe(true);
    expect(CARD_PAGE_PATH.test("/en/checkout/pay/card/")).toBe(true);
    expect(
      CARD_PAGE_PATH.test(
        "/he/checkout/pay/0d4f7a52-6a1e-4c1e-9b8e-0f6f6e6b8a11",
      ),
    ).toBe(false);
    expect(CARD_PAGE_PATH.test("/he/checkout/pay/cards")).toBe(false);
    const rules = (await nextConfig(PHASE_PRODUCTION_BUILD).headers?.()) ?? [];
    const global = rules.find((r) => r.source === "/:path*");
    const globalHeaders = (global?.headers ?? []) as Header[];
    expect(
      globalHeaders.some(
        (h) => h.key.toLowerCase() === "content-security-policy",
      ),
    ).toBe(false);
  });

  it("the pay page policy: nonce and strict-dynamic, PayMe's script and frames only", () => {
    const d = directives(payPageCsp("abc123==", { dev: false }));
    expect(d.get("script-src")).toBe(
      `'self' 'nonce-abc123==' 'strict-dynamic' ${PAYME_HOSTS.script}`,
    );
    expect(d.get("script-src")).not.toContain("unsafe-inline");
    expect(d.get("frame-src")).toBe("https://hf.payme.io");
    expect(d.get("connect-src")).toBe(
      "'self' https://hf.payme.io https://sandbox.payme.io https://live.payme.io",
    );
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'none'");
    expect(d.get("form-action")).toBe("'self'");
    const dev = directives(payPageCsp("n", { dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toContain("ws:");
  });

  it("our own card page: nonce and strict-dynamic, and nothing from outside the site", () => {
    const policy = cardPageCsp("abc123==", { dev: false });
    const d = directives(policy);
    expect(d.get("script-src")).toBe(
      "'self' 'nonce-abc123==' 'strict-dynamic'",
    );
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("frame-src")).toBe("'none'");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("form-action")).toBe("'self'");
    expect(d.get("base-uri")).toBe("'none'");
    expect(policy).not.toMatch(/payme|cardcom|paypal/i);
    expect(d.get("script-src")).not.toContain("unsafe-inline");
    const dev = directives(cardPageCsp("n", { dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
  });

  it("production with an https APP_URL moves plain HTTP (CF-Visitor) to https", async () => {
    Object.assign(process.env, {
      APP_ENV: "production",
      APP_URL: "https://geula.example.test",
      REDIRECT_HOSTS: "",
    });
    const rules =
      (await nextConfig(PHASE_PRODUCTION_BUILD).redirects?.()) ?? [];
    const https = rules.find((r) =>
      r.has?.some((h) => h.type === "header" && h.key === "cf-visitor"),
    );
    expect(https).toMatchObject({
      source: "/:path*",
      destination: "https://geula.example.test/:path*",
      permanent: true,
    });
    const value =
      https?.has?.[0] && "value" in https.has[0] ? https.has[0].value : "";
    const matcher = new RegExp(`^${value}$`); // how Next matches `has` values
    expect(matcher.test('{"scheme":"http"}')).toBe(true);
    expect(matcher.test('{"scheme":"https"}')).toBe(false);

    Object.assign(process.env, {
      APP_ENV: "development",
      APP_URL: "http://localhost:3000",
    });
    const dev = (await nextConfig(PHASE_PRODUCTION_BUILD).redirects?.()) ?? [];
    expect(dev.some((r) => r.has?.some((h) => h.type === "header"))).toBe(
      false,
    );
  });

  it("token pages send no Referer; admin is noindex and no-store", async () => {
    const rules = (await nextConfig(PHASE_PRODUCTION_BUILD).headers?.()) ?? [];
    const bySource = new Map(
      rules.map((r) => [
        r.source,
        new Map((r.headers as Header[]).map((h) => [h.key, h.value])),
      ]),
    );
    // `strict-origin` (not `no-referrer`): Server Action POSTs need a real Origin header.
    expect(bySource.get("/:locale/orders/:path*")?.get("Referrer-Policy")).toBe(
      "strict-origin",
    );
    expect(bySource.get("/:locale/print/:path*")?.get("Referrer-Policy")).toBe(
      "no-referrer",
    );
    // The pay page posts to a Server Action too.
    expect(
      bySource.get("/:locale/checkout/pay/:path*")?.get("Referrer-Policy"),
    ).toBe("strict-origin");
    const admin = bySource.get("/:locale/admin/:path*");
    expect(admin?.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(admin?.get("Cache-Control")).toBe("no-store");
  });
});
