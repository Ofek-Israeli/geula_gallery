import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/routes";
import { env } from "@/server/env";

/**
 * `/robots.txt` (spec §6.6): allow everything except `/api/`. Private pages carry `noindex`
 * metadata, and demo deployments send `X-Robots-Tag: noindex, nofollow` on every route
 * (`next.config.ts`, spec §6.9), so this file does not change with `DEMO_MODE`.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: absoluteUrl(env.APP_URL, "/sitemap.xml"),
  };
}
