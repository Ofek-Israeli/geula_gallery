import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

/**
 * Proxy (spec §2.1, §6.4). Never touches the DB and is never the only auth check: every admin
 * page, action and route calls `requireAdmin()` itself (spec §1.1.7).
 *
 * 1. Optimistic admin redirect: `/(he|en)/admin/**` (except `/admin/login/**`) and
 *    `/(he|en)/print/admin/**` without a Better Auth session cookie go to the login page.
 *    The cookie is not validated here (a forged cookie gets through and is rejected by
 *    `requireAdmin`).
 * 2. Everything else: next-intl routing (`/` → `/he` or `/en` by Accept-Language, 307).
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
  return intl(request);
}

export const config = {
  // Excludes api, Next internals, Vercel internals and any path with a dot (files).
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
