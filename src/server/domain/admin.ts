import "server-only";
import type { Locale } from "@/lib/locale";

declare const adminContextBrand: unique symbol;

/**
 * Proof that the caller is a signed-in admin (spec §2.2, §6.10). Only `requireAdmin()` /
 * `requireAdminForRoute()` in `src/server/next/guards.ts` produce it. Admin service functions that
 * read buyer PII take `ctx: AdminContext`, so they cannot be called without a guard.
 */
export type AdminContext = {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  readonly sessionCreatedAt: Date;
  readonly twoFactorEnabled: boolean;
  readonly locale: Locale;
  /** HMAC of the client IP (never the raw IP), for audit rows. */
  readonly ipHash: string | null;
  /** Audit actor string: `admin:<userId>`. */
  readonly actor: string;
} & { readonly [adminContextBrand]: true };

export const SYSTEM_ACTOR = "system";
export const ANONYMOUS_ACTOR = "anonymous";

export function adminActor(userId: string): string {
  return `admin:${userId}`;
}
