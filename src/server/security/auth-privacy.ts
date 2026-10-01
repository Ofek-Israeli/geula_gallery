import "server-only";
import { env } from "@/server/env";
import { hmacHex } from "./crypto";
import { hashIp } from "./ip";
import { appKey } from "./keys";
import { scaledLimit } from "./limits";
import { rateLimit } from "./rate-limit";

/**
 * Privacy adapters for Better Auth (spec §7: IPs are stored only as HMAC hashes).
 *
 * - `authRateLimitStorage`: Better Auth's limiter keys are `<ip>|<path>`; we store them in our own
 *   Postgres fixed-window table (`rate_limits`) under an HMAC of the key, so no raw IP is
 *   persisted. Limits are scaled by `RATE_LIMIT_SCALE` like every other limit (E2E uses 100;
 *   production is forced to 1).
 * - `hashSessionIp`: `session.ip_address` holds the IP hash, never the IP.
 */
export const authRateLimitStorage = {
  async consume(key: string, rule: { window: number; max: number }) {
    const hashed = hmacHex(appKey("rate-limit"), key).slice(0, 32);
    const result = await rateLimit(
      `auth:${hashed}`,
      scaledLimit(rule.max, env.RATE_LIMIT_SCALE, env.isProduction),
      rule.window,
    );
    return {
      allowed: result.allowed,
      retryAfter: result.allowed ? null : result.retryAfterSec,
    };
  },
};

/** Works for creates and partial updates: only a present, non-empty `ipAddress` is replaced. */
export async function hashSessionIp<T extends { ipAddress?: string | null }>(
  session: T,
): Promise<{ data: T }> {
  if (!session.ipAddress) return { data: session };
  return { data: { ...session, ipAddress: hashIp(session.ipAddress) } };
}
