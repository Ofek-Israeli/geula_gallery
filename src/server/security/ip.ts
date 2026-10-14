import "server-only";
import { env } from "@/server/env";
import { hmacHex } from "./crypto";
import { appKey } from "./keys";

/**
 * Client IP handling (spec §7: IPs are stored only as HMAC hashes). The raw IP is used only
 * transiently to compute the hash.
 * - `CLIENT_IP_HEADER` set (behind Cloudflare: `cf-connecting-ip`, which Cloudflare overwrites):
 *   only that header counts, so a visitor cannot pick their own rate-limit key with a forged
 *   `x-real-ip` / `x-forwarded-for`.
 * - Otherwise (Vercel, local `next start`): `x-real-ip`, then the first `x-forwarded-for` entry.
 */
export function clientIp(
  headers: Headers,
  trusted: string | undefined = env.CLIENT_IP_HEADER,
): string | null {
  if (trusted) {
    return headers.get(trusted)?.split(",")[0]?.trim() || null;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}

export function hashIpWithKey(key: Buffer, ip: string): string {
  return hmacHex(key, ip.toLowerCase()).slice(0, 32);
}

/** Keyed hash of an IP (HKDF purpose `ip-hash`), 32 hex chars. */
export function hashIp(ip: string): string {
  return hashIpWithKey(appKey("ip-hash"), ip);
}

/** Hash of the request's client IP, or null when unknown. */
export function ipHashFrom(headers: Headers): string | null {
  const ip = clientIp(headers);
  return ip ? hashIp(ip) : null;
}
