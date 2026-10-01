import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants";
import { afterEach, describe, expect, it } from "vitest";
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
  return new Map(
    (all.headers as Header[]).map((h) => [h.key.toLowerCase(), h.value]),
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

  it("token pages send no Referer; admin is noindex and no-store", async () => {
    const rules = (await nextConfig(PHASE_PRODUCTION_BUILD).headers?.()) ?? [];
    const bySource = new Map(
      rules.map((r) => [
        r.source,
        new Map((r.headers as Header[]).map((h) => [h.key, h.value])),
      ]),
    );
    expect(bySource.get("/:locale/orders/:path*")?.get("Referrer-Policy")).toBe(
      "no-referrer",
    );
    expect(bySource.get("/:locale/print/:path*")?.get("Referrer-Policy")).toBe(
      "no-referrer",
    );
    const admin = bySource.get("/:locale/admin/:path*");
    expect(admin?.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(admin?.get("Cache-Control")).toBe("no-store");
  });
});
