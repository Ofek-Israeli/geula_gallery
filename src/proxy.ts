import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { newNonce, PAY_PAGE_PATH, payPageCsp } from "./lib/csp";
import { publicEnv } from "./lib/public-env";

/**
 * Proxy (spec §2.1, §6.4). Never touches the DB and is never the only auth check: every admin
 * page, action and route calls `requireAdmin()` itself (spec §1.1.7).
 *
 * 1. Optimistic admin redirect: `/(he|en)/admin/**` (except `/admin/login/**`) and
 *    `/(he|en)/print/admin/**` without a Better Auth session cookie go to the login page.
 *    The cookie is not validated here (a forged cookie gets through and is rejected by
 *    `requireAdmin`).
 * 2. The Isracard pay page (`/(he|en)/checkout/pay/*`): a per-request nonce CSP (`src/lib/csp.ts`),
 *    set on the response and passed to the render as `content-security-policy` + `x-nonce` request
 *    headers (Next adds the nonce to its own scripts; the page gives it to PayMe's script). The
 *    static CSP of `next.config.ts` skips this path.
 * 3. Everything else: next-intl routing (`/` → `/he` or `/en` by Accept-Language, 307).
 */
const intl = createMiddleware(routing);

const PROTECTED =
  /^\/(he|en)\/(?:admin(?!\/login(?:\/|$))|print\/admin)(?:\/|$)/;

export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const match = PROTECTED.exec(pathname);
  if (match && !getSessionCookie(request)) {
    const login = request.nextUrl.clone();
    login.pathname = `/${match[1]}/admin/login`;
    login.search = "";
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login, 307);
  }
  if (PAY_PAGE_PATH.test(pathname)) {
    const nonce = newNonce();
    const csp = payPageCsp(nonce, { dev: publicEnv.devServer });
    const forwarded = new Headers(request.headers);
    forwarded.set("x-nonce", nonce);
    forwarded.set("content-security-policy", csp);
    const response = intl(new NextRequest(request, { headers: forwarded }));
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }
  return intl(request);
}

export const config = {
  // Excludes api, Next internals, Vercel internals and any path with a dot (files).
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
