import "server-only";

/**
 * Abuse limits (spec §7 Abuse, §3.5). Fixed windows in Postgres (`rate-limit.ts`). Every limit
 * is scaled by `RATE_LIMIT_SCALE` (E2E uses 100); `env.ts` refuses a scale ≠ 1 in production and
 * `scaledLimit` re-checks it.
 *
 * Admin sign-in and TOTP limits are Better Auth's own database limits (`auth/options.ts`).
 */
export const LIMITS = {
  /** Checkout start / pay order: 10 per 10 min per IP. */
  checkoutIp: { limit: 10, windowSec: 600 },
  /** Checkout start / pay order: 5 per hour per email. */
  checkoutEmail: { limit: 5, windowSec: 3600 },
  /** Buyer requests (question, quote, offer, contact): 5 per hour per IP. */
  requestIp: { limit: 5, windowSec: 3600 },
  /** Cancellation notices: 20 per hour per IP. */
  cancellationIp: { limit: 20, windowSec: 3600 },
  /** Payment return route: 60 per minute per IP. */
  returnIp: { limit: 60, windowSec: 60 },
  /** Webhook authentication failures: 30 per minute per IP (authenticated requests never limited). */
  webhookAuthFailureIp: { limit: 30, windowSec: 60 },
  /** PayPal webhook before signature verification: 60 per minute per IP. */
  paypalPreverifyIp: { limit: 60, windowSec: 60 },
  /** Bad order `k` tokens: 30 per minute per IP. */
  badOrderKeyIp: { limit: 30, windowSec: 60 },
} as const satisfies Record<string, { limit: number; windowSec: number }>;

export type LimitName = keyof typeof LIMITS;

export class RateLimitScaleError extends Error {
  constructor() {
    super("RATE_LIMIT_SCALE must be 1 in production");
    this.name = "RateLimitScaleError";
  }
}

/** Pure: the effective limit for a scale. Never below 1. */
export function scaledLimit(
  limit: number,
  scale: number,
  isProduction: boolean,
): number {
  if (isProduction && scale !== 1) throw new RateLimitScaleError();
  if (!Number.isFinite(scale) || scale <= 0) return limit;
  return Math.max(1, Math.floor(limit * scale));
}
