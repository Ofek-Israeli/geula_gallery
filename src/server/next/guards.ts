import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { locale as rootLocale } from "next/root-params";
import { DEFAULT_LOCALE_VALUE, isLocale, type Locale } from "@/lib/locale";
import {
  adminLoginPath,
  checkAdminSession,
  FRESH_SESSION_MAX_AGE_MS,
  safeAdminNext,
} from "@/server/auth/policy";
import { type AdminContext, adminActor } from "@/server/domain/admin";
import { env } from "@/server/env";
import { ipHashFrom } from "@/server/security/ip";
import { type AuthSession, auth } from "./auth";

export type { AdminContext } from "@/server/domain/admin";
export { adminLoginPath, FRESH_SESSION_MAX_AGE_MS, safeAdminNext };

export interface RequireAdminOptions {
  /** Money and settings actions need a session created ≤ 30 min ago. */
  fresh?: boolean;
  /** Only the enroll-2fa page: allow a signed-in admin who has not enrolled TOTP yet. */
  allowUnenrolled?: boolean;
  /** Pass it from Server Actions and Route Handlers (root params are unavailable there). */
  locale?: Locale;
}

async function resolveLocale(explicit: Locale | undefined): Promise<Locale> {
  if (explicit) return explicit;
  try {
    const fromRoot = await rootLocale();
    if (isLocale(fromRoot)) return fromRoot;
  } catch {
    // next/root-params throws in Server Actions and Route Handlers; callers there pass `locale`.
  }
  return DEFAULT_LOCALE_VALUE;
}

/** The current Better Auth session, validated against the DB (or null). Never trusts the cookie alone. */
export async function getAdminSession(
  requestHeaders?: Headers,
): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: requestHeaders ?? (await headers()) });
}

function toAdminContext(
  session: AuthSession,
  locale: Locale,
  requestHeaders: Headers,
): AdminContext {
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.session.id,
    sessionCreatedAt: new Date(session.session.createdAt),
    twoFactorEnabled: session.user.twoFactorEnabled === true,
    locale,
    ipHash: ipHashFrom(requestHeaders),
    actor: adminActor(session.user.id),
  } as AdminContext;
}

/**
 * The admin guard (spec §1.1.7, §6.10). Call it in `(panel)/layout.tsx` AND at the top of every
 * admin `page.tsx`, in the `print/admin` layout and pages, and (through `adminAction`) in every
 * admin Server Action. Redirects to login, to enroll-2fa, or to re-authentication.
 */
export async function requireAdmin(
  opts: RequireAdminOptions = {},
): Promise<AdminContext> {
  const locale = await resolveLocale(opts.locale);
  const requestHeaders = await headers();
  const session = await getAdminSession(requestHeaders);
  const check = checkAdminSession(session, {
    fresh: opts.fresh,
    allowUnenrolled: opts.allowUnenrolled,
    require2fa: env.ADMIN_REQUIRE_2FA,
  });
  if (!check.ok) {
    if (check.reason === "unauthenticated") redirect(adminLoginPath(locale));
    if (check.reason === "enroll-2fa") redirect(`/${locale}/admin/enroll-2fa`);
    redirect(adminLoginPath(locale, { reauth: true }));
  }
  return toAdminContext(check.session, locale, requestHeaders);
}

// ---------------------------------------------------------------- route handlers

export class AdminRouteError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code:
      | "UNAUTHENTICATED"
      | "ENROLL_2FA"
      | "STALE_SESSION"
      | "BAD_ORIGIN",
  ) {
    super(code);
    this.name = "AdminRouteError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mutating admin requests must come from our own origin (spec §6.10 "plus an Origin check"). */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  const allowed = new URL(env.APP_URL).origin;
  if (!origin || origin !== allowed) {
    throw new AdminRouteError(403, "BAD_ORIGIN");
  }
}

/**
 * The admin guard for Route Handlers (`api/admin/**`): Origin check for mutations, then the same
 * session checks as `requireAdmin`, throwing `AdminRouteError` instead of redirecting.
 */
export async function requireAdminForRoute(
  request: Request,
  opts: Omit<RequireAdminOptions, "allowUnenrolled"> = {},
): Promise<AdminContext> {
  assertSameOrigin(request);
  const session = await getAdminSession(request.headers);
  const check = checkAdminSession(session, {
    fresh: opts.fresh,
    require2fa: env.ADMIN_REQUIRE_2FA,
  });
  if (!check.ok) {
    if (check.reason === "unauthenticated")
      throw new AdminRouteError(401, "UNAUTHENTICATED");
    if (check.reason === "enroll-2fa")
      throw new AdminRouteError(403, "ENROLL_2FA");
    throw new AdminRouteError(403, "STALE_SESSION");
  }
  return toAdminContext(
    check.session,
    opts.locale ?? DEFAULT_LOCALE_VALUE,
    request.headers,
  );
}

/**
 * Wraps an admin Route Handler: `export const POST = adminRoute(async (request, ctx) => …)`.
 * Guard failures become JSON 401/403 responses (no-store).
 */
export function adminRoute<Rest extends unknown[]>(
  handler: (
    request: Request,
    ctx: AdminContext,
    ...rest: Rest
  ) => Promise<Response>,
  opts: Omit<RequireAdminOptions, "allowUnenrolled"> = {},
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    let ctx: AdminContext;
    try {
      ctx = await requireAdminForRoute(request, opts);
    } catch (error) {
      if (error instanceof AdminRouteError) {
        return Response.json(
          { error: error.code },
          { status: error.status, headers: { "Cache-Control": "no-store" } },
        );
      }
      throw error;
    }
    return handler(request, ctx, ...rest);
  };
}
