import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Build-time config. Runtime policy is validated in `src/server/env.ts`; here we only read the few
 * variables that shape static headers and image config (they are baked in at build time).
 */
function buildConfig(phase: string): NextConfig {
  const isDevServer = phase === PHASE_DEVELOPMENT_SERVER;
  const isProduction = process.env.APP_ENV === "production";
  const demoMode = process.env.DEMO_MODE === "true";
  const blobHost = process.env.NEXT_PUBLIC_BLOB_HOST?.trim();

  // Static CSP, no nonces (§7). Redirect-only payments: no third-party scripts or frames.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDevServer ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com",
    "font-src 'self'",
    `connect-src 'self'${isDevServer ? " ws:" : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://secure.cardcom.solutions https://www.paypal.com https://www.sandbox.paypal.com",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const securityHeaders = [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    ...(isProduction
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ]
      : []),
    // §6.9: demo mode is noindex on every route.
    ...(demoMode ? [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] : []),
  ];

  return {
    distDir: process.env.NEXT_DIST_DIR ?? ".next",
    poweredByHeader: false,
    reactStrictMode: true,
    experimental: {
      globalNotFound: true,
      serverActions: { bodySizeLimit: "1mb" },
    },
    images: {
      qualities: [75, 90],
      formats: ["image/avif", "image/webp"],
      deviceSizes: [640, 828, 1080, 1280, 1600, 1920, 2048],
      localPatterns: [
        { pathname: "/api/files/public/**" },
        { pathname: "/brand/**" },
      ],
      remotePatterns: blobHost
        ? [{ protocol: "https", hostname: blobHost, pathname: "/**" }]
        : [],
    },
    // react-pdf fonts must be traced into every server route that can render documents
    // (after() outbox processing, cron). '/*' is the all-routes key (picomatch `contains`).
    outputFileTracingIncludes: {
      "/*": ["./assets/fonts/**/*"],
    },
    async headers() {
      return [
        { source: "/:path*", headers: securityHeaders },
        // Token pages (?k=) must not leak their URL via Referer. The order page uses
        // `strict-origin`, not `no-referrer`: it has Server Action forms, and under `no-referrer`
        // browsers send `Origin: null` on POST (always for a native form submit, i.e. before
        // hydration or without JS), which Next's CSRF check rejects with a 500. `strict-origin`
        // still sends only the origin (never the path or `?k=`) as Referer.
        {
          source: "/:locale/orders/:path*",
          headers: [{ key: "Referrer-Policy", value: "strict-origin" }],
        },
        {
          source: "/:locale/print/:path*",
          headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
        },
        {
          source: "/:locale/admin/:path*",
          headers: [
            { key: "X-Robots-Tag", value: "noindex, nofollow" },
            { key: "Cache-Control", value: "no-store" },
          ],
        },
      ];
    },
  };
}

export default function nextConfig(phase: string): NextConfig {
  return withNextIntl(buildConfig(phase));
}
