/**
 * Content-Security-Policy builders (pure; `next.config.ts` and `src/proxy.ts`).
 *
 * - Every page except the pay page: the static policy (no nonces, no third-party scripts or
 *   frames; form posts may go to the redirect providers' hosted pages).
 * - The Isracard pay page (`/[locale]/checkout/pay/<attempt>`): a per-request nonce policy from
 *   the proxy. Only our own nonce'd scripts and PayMe's hosted-fields script run
 *   (`'strict-dynamic'`), frames only from PayMe's hosted-fields origin, no inline scripts. This
 *   keeps the card page protected against script attacks (PCI SSC FAQ 1588).
 * - Our own card page (`/[locale]/checkout/pay/card`): the same nonce policy with no third-party
 *   origin at all (no scripts, frames or connections outside the site).
 */

/** PayMe (Isracard's e-commerce service): hosted-fields script, its frames, and its API. */
export const PAYME_HOSTS = {
  script: "https://cdn.payme.io",
  frames: "https://hf.payme.io",
  api: ["https://sandbox.payme.io", "https://live.payme.io"],
} as const;

/** Hosted payment pages a checkout form may post to (redirect providers). */
export const REDIRECT_PROVIDER_ORIGINS = [
  "https://secure.cardcom.solutions",
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
] as const;

/** `/he/checkout/pay/<id>` and `/en/checkout/pay/<id>` (and our own card page below). */
export const PAY_PAGE_PATH = /^\/(?:he|en)\/checkout\/pay\//;

/** Our own card page, `/he/checkout/pay/card` and `/en/checkout/pay/card`. */
export const CARD_PAGE_PATH = /^\/(?:he|en)\/checkout\/pay\/card\/?$/;

/** `next.config.ts` header source: every path except the pay page (no capturing groups). */
export const STATIC_CSP_SOURCE = "/:path((?!(?:he|en)/checkout/pay/).*)";

const IMG_SRC =
  "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com";

export function staticCsp(o: { dev: boolean; production: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${o.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    IMG_SRC,
    "font-src 'self'",
    `connect-src 'self'${o.dev ? " ws:" : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${REDIRECT_PROVIDER_ORIGINS.join(" ")}`,
    ...(o.production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function payPageCsp(nonce: string, o: { dev: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${PAYME_HOSTS.script}${o.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    IMG_SRC,
    "font-src 'self'",
    `connect-src 'self' ${PAYME_HOSTS.frames} ${PAYME_HOSTS.api.join(" ")}${o.dev ? " ws:" : ""}`,
    `frame-src ${PAYME_HOSTS.frames}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** Our own card page: nothing from outside the site may run, frame, load or be contacted. */
export function cardPageCsp(nonce: string, o: { dev: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    IMG_SRC,
    "font-src 'self'",
    `connect-src 'self'${o.dev ? " ws:" : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** A fresh nonce per request (128 random bits, base64). */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
