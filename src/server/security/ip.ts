import "server-only";
import { hmacHex } from "./crypto";
import { appKey } from "./keys";

/**
 * Client IP handling (spec §7: IPs are stored only as HMAC hashes).
 * On Vercel, `x-real-ip` / `x-forwarded-for` are set by the platform edge; locally `next start`
 * sets `x-forwarded-for`. The raw IP is used only transiently to compute the hash.
 */
export function clientIp(headers: Headers): string | null {
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
