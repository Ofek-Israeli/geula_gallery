/**
 * Route builders (spec §2.3, §6.2). One place for every URL shape so pages, emails, providers and
 * tests agree.
 *
 * - `paths.*` return **locale-less** paths (`/works/sunset`) for next-intl's `<Link>`, `redirect`
 *   and `getPathname`, which add the locale prefix themselves.
 * - `localePath(locale, path)` adds the prefix (`/he/works/sunset`) for plain `<a>`, emails,
 *   provider return URLs and route handlers (root params are not available there).
 * - `apiPaths.*` are locale-free API routes.
 * - `absoluteUrl(base, path)` joins with `APP_URL` / `PUBLIC_WEBHOOK_BASE_URL`.
 */
import type { Locale } from "./locale";

export const LEGAL_DOCS = [
  "terms",
  "returns",
  "shipping",
  "privacy",
  "accessibility",
] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

export function isLegalDoc(value: unknown): value is LegalDoc {
  return (
    typeof value === "string" &&
    (LEGAL_DOCS as readonly string[]).includes(value)
  );
}

export type RequestKind = "question" | "quote" | "offer";
export type UploadPurpose = "artwork" | "packing" | "return";
export type PaymentProviderSlug = "mock" | "cardcom" | "paypal";
export type CronJobName =
  | "reconcile"
  | "outbox"
  | "tracking"
  | "daily"
  | "purge";

export type QueryValue = string | number | boolean | null | undefined;

/** Appends a query string, skipping null/undefined/empty values; keys keep insertion order. */
export function withQuery(
  path: string,
  query: Record<string, QueryValue> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

/** Locale-less paths for next-intl navigation. */
export const paths = {
  home: () => "/",
  works: (query?: Record<string, QueryValue>) => withQuery("/works", query),
  artwork: (slug: string) => `/works/${seg(slug)}`,
  artworkRequest: (slug: string, kind: RequestKind) =>
    withQuery(`/works/${seg(slug)}/request`, { kind }),
  about: () => "/about",
  contact: (topic?: string) => withQuery("/contact", { topic }),
  credits: () => "/credits",
  legal: (doc: LegalDoc) => `/legal/${doc}`,
  /** `prefill` carries the order number from an order page or email (never PII). */
  cancel: (orderNumber?: string) =>
    withQuery("/cancel", { order: orderNumber }),
  checkout: (
    slug: string,
    query: { to?: string; ship?: string; cur?: string } = {},
  ) => withQuery(`/checkout/${seg(slug)}`, query),
  checkoutReturned: (query: Record<string, QueryValue> = {}) =>
    withQuery("/checkout/returned", query),
  mockPay: (ref: string) => `/mock-pay/${seg(ref)}`,
  /** Buyer order page; `k` is the order access token. */
  order: (orderNumber: string, token: string) =>
    withQuery(`/orders/${seg(orderNumber)}`, { k: token }),
  printDisclosure: (orderNumber: string, token: string) =>
    withQuery(`/print/disclosure/${seg(orderNumber)}`, { k: token }),
  printReceipt: (docNumber: string, token: string) =>
    withQuery(`/print/receipt/${seg(docNumber)}`, { k: token }),
  admin: {
    dashboard: () => "/admin",
    login: (next?: string) => withQuery("/admin/login", { next }),
    login2fa: (next?: string) => withQuery("/admin/login/2fa", { next }),
    enroll2fa: () => "/admin/enroll-2fa",
    artworks: () => "/admin/artworks",
    artwork: (id: string) => `/admin/artworks/${seg(id)}`,
    newArtwork: () => "/admin/artworks/new",
    orders: (query?: Record<string, QueryValue>) =>
      withQuery("/admin/orders", query),
    order: (id: string) => `/admin/orders/${seg(id)}`,
    fulfill: (id: string) => `/admin/orders/${seg(id)}/fulfill`,
    newOrder: () => "/admin/orders/new",
    inbox: () => "/admin/inbox",
    request: (id: string) => `/admin/inbox/${seg(id)}`,
    cancellations: () => "/admin/cancellations",
    cancellation: (id: string) => `/admin/cancellations/${seg(id)}`,
    newCancellation: () => "/admin/cancellations/new",
    alerts: () => "/admin/alerts",
    settings: (
      section?: "business" | "checkout" | "shipping" | "cancellation",
    ) => (section ? `/admin/settings/${section}` : "/admin/settings"),
    account: () => "/admin/account",
    more: () => "/admin/more",
    print: {
      packingSlip: (orderId: string) =>
        `/print/admin/packing-slip/${seg(orderId)}`,
      commercialInvoice: (orderId: string) =>
        `/print/admin/commercial-invoice/${seg(orderId)}`,
      coa: (saleId: string) => `/print/admin/coa/${seg(saleId)}`,
      studioNotice: () => "/print/admin/studio-notice",
    },
  },
} as const;

/** `/he` + `/works/x` → `/he/works/x`; `/` → `/he`. */
export function localePath(locale: Locale, path: string): string {
  if (!path.startsWith("/")) throw new RangeError("path must start with /");
  if (path === "/") return `/${locale}`;
  if (path.startsWith("/?")) return `/${locale}${path.slice(1)}`;
  return `/${locale}${path}`;
}

/** Locale-free API routes. */
export const apiPaths = {
  paymentWebhook: (
    provider: PaymentProviderSlug,
    query: Record<string, QueryValue> = {},
  ) => withQuery(`/api/payments/${provider}/webhook`, query),
  paymentReturn: (
    provider: PaymentProviderSlug,
    query: Record<string, QueryValue> = {},
  ) => withQuery(`/api/payments/${provider}/return`, query),
  cron: (job: CronJobName) => `/api/cron/${job}`,
  /** Storage keys may contain `/`; each segment is encoded. */
  publicFile: (key: string) =>
    `/api/files/public/${key.split("/").map(seg).join("/")}`,
  privateFile: (key: string, query: Record<string, QueryValue> = {}) =>
    withQuery(`/api/files/private/${key.split("/").map(seg).join("/")}`, query),
  adminUploads: (purpose: UploadPurpose) =>
    withQuery("/api/admin/uploads", { purpose }),
  health: () => "/api/health",
} as const;

/** Joins a base URL (no trailing slash needed) and an absolute path. */
export function absoluteUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
