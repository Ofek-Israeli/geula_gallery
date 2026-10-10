"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

/**
 * Vercel Web Analytics on the public pages (no cookies, nothing personal). Only the path is sent:
 * query strings are dropped (checkout carries the buyer's city and postal code, order pages an
 * access key) and order numbers are masked. Rendered only on Vercel (`env.VERCEL`).
 */
export function cleanAnalyticsUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/orders\/[^/]+/, "/orders/[number]");
  return `${u.origin}${path}`;
}

export function SiteAnalytics() {
  return (
    <Analytics
      beforeSend={(event: BeforeSendEvent) => ({
        ...event,
        url: cleanAnalyticsUrl(event.url),
      })}
    />
  );
}
