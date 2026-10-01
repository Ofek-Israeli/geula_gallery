import "server-only";
import type { Locale } from "@/lib/locale";

/**
 * Pure admin-session policy shared by the page guard, the route guard and the login pages
 * (spec §6.10). No I/O, unit-tested.
 */

/** `fresh` sessions are at most 30 minutes old (spec §6.10). */
export const FRESH_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

export interface SessionLike {
  session: { createdAt: Date | string };
  user: { twoFactorEnabled?: boolean | null };
}

export type AdminCheck<S extends SessionLike> =
  | { ok: true; session: S }
  | { ok: false; reason: "unauthenticated" | "enroll-2fa" | "stale" };

export function checkAdminSession<S extends SessionLike>(
  session: S | null,
  opts: {
    fresh?: boolean;
    allowUnenrolled?: boolean;
    require2fa: boolean;
    now?: number;
  },
): AdminCheck<S> {
  if (!session) return { ok: false, reason: "unauthenticated" };
  if (
    opts.require2fa &&
    session.user.twoFactorEnabled !== true &&
    !opts.allowUnenrolled
  ) {
    return { ok: false, reason: "enroll-2fa" };
  }
  if (opts.fresh) {
    const age =
      (opts.now ?? Date.now()) - new Date(session.session.createdAt).getTime();
    if (!(age <= FRESH_SESSION_MAX_AGE_MS))
      return { ok: false, reason: "stale" };
  }
  return { ok: true, session };
}

export function adminLoginPath(
  locale: Locale,
  opts: { next?: string; reauth?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (opts.next) params.set("next", opts.next);
  if (opts.reauth) params.set("reauth", "1");
  const query = params.toString();
  return `/${locale}/admin/login${query ? `?${query}` : ""}`;
}

const ADMIN_NEXT = /^\/(he|en)\/(admin|print\/admin)(\/|\?|$)/;
const LOGIN_PATH = /^\/(he|en)\/admin\/login(\/|\?|$)/;

/**
 * Where to go after sign-in: only a same-site admin path (never `//host`, never a backslash trick,
 * never the login pages themselves); anything else falls back to the dashboard.
 */
export function safeAdminNext(
  locale: Locale,
  next: string | null | undefined,
): string {
  if (
    next &&
    ADMIN_NEXT.test(next) &&
    !next.includes("\\") &&
    !next.includes("//") &&
    !LOGIN_PATH.test(next)
  ) {
    return next;
  }
  return `/${locale}/admin`;
}
