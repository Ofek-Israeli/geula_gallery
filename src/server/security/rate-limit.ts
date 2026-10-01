import "server-only";
import { sql } from "drizzle-orm";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { rateLimits } from "@/server/db/schema";
import { env } from "@/server/env";
import { hmacHex } from "./crypto";
import { appKey } from "./keys";
import { LIMITS, type LimitName, scaledLimit } from "./limits";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** When the current window ends. */
  resetAt: Date;
  retryAfterSec: number;
}

/** Start of the fixed window containing `now`. */
export function windowStartOf(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Postgres fixed-window counter (spec §7): one upsert, atomic under concurrency.
 * Keys must not contain raw PII; use `checkLimit`, which hashes the subject.
 * Rows are purged after 2 days by the purge job.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
  opts: { db?: DbOrTx; now?: Date } = {},
): Promise<RateLimitResult> {
  const now = opts.now ?? new Date();
  const windowStart = windowStartOf(now, windowSec);
  const [row] = await (opts.db ?? defaultDb)
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1`, updatedAt: now },
    })
    .returning({ count: rateLimits.count });
  const count = row?.count ?? 1;
  const resetAt = new Date(windowStart.getTime() + windowSec * 1000);
  return {
    allowed: count <= limit,
    count,
    limit,
    resetAt,
    retryAfterSec: Math.max(
      1,
      Math.ceil((resetAt.getTime() - now.getTime()) / 1000),
    ),
  };
}

/**
 * Applies a named limit from `limits.ts` to a subject (an IP hash, an email, …). The subject is
 * HMAC-hashed into the key, so no raw IP or email is stored.
 */
export async function checkLimit(
  name: LimitName,
  subject: string,
  opts: { db?: DbOrTx; now?: Date } = {},
): Promise<RateLimitResult> {
  const { limit, windowSec } = LIMITS[name];
  const effective = scaledLimit(limit, env.RATE_LIMIT_SCALE, env.isProduction);
  const subjectHash = hmacHex(
    appKey("rate-limit"),
    subject.toLowerCase(),
  ).slice(0, 32);
  return rateLimit(`${name}:${subjectHash}`, effective, windowSec, opts);
}
