import "server-only";
import { hmacBase64Url, safeEqual } from "./crypto";
import { appKey, type KeyPurpose } from "./keys";

/**
 * HMAC tokens (spec §4.2, §5.1, §7).
 *
 * - `hmacToken(purpose, value)`: deterministic, truncated to 32 chars (Cardcom notify/return tokens
 *   are HMACs of the attempt id; order `?k=` tokens are HMACs of `orderId:accessVersion`).
 * - `signToken` / `verifySignedToken`: expiring payload tokens (signed file URLs ≤ 10 min, the
 *   cancellation review payload, the form-start timestamp).
 */

export const HMAC_TOKEN_LENGTH = 32;

export function hmacTokenWithKey(
  key: Buffer,
  value: string,
  length = HMAC_TOKEN_LENGTH,
): string {
  return hmacBase64Url(key, value).slice(0, length);
}

export function hmacToken(
  purpose: KeyPurpose,
  value: string,
  length = HMAC_TOKEN_LENGTH,
): string {
  return hmacTokenWithKey(appKey(purpose), value, length);
}

export function verifyHmacToken(
  purpose: KeyPurpose,
  value: string,
  token: string | null | undefined,
  length = HMAC_TOKEN_LENGTH,
): boolean {
  if (!token || token.length !== length) return false;
  return safeEqual(hmacToken(purpose, value, length), token);
}

/** The order page / buyer printables token (`?k=`). Bumping `accessVersion` revokes old links. */
export function orderAccessToken(
  orderId: string,
  accessVersion: number,
): string {
  return hmacToken("order-access", `${orderId}:${accessVersion}`);
}

export function verifyOrderAccessToken(
  orderId: string,
  accessVersion: number,
  token: string | null | undefined,
): boolean {
  return verifyHmacToken("order-access", `${orderId}:${accessVersion}`, token);
}

// ---------------------------------------------------------------- expiring signed tokens

export function signTokenWithKey(
  key: Buffer,
  payload: Record<string, unknown>,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp }),
    "utf8",
  ).toString("base64url");
  return `${body}.${hmacBase64Url(key, body)}`;
}

export function verifyTokenWithKey<T extends Record<string, unknown>>(
  key: Buffer,
  token: string | null | undefined,
  now: Date = new Date(),
): (T & { exp: number }) | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(hmacBase64Url(key, body), sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.exp !== "number" ||
      payload.exp < Math.floor(now.getTime() / 1000)
    ) {
      return null;
    }
    return payload as T & { exp: number };
  } catch {
    return null;
  }
}

export function signToken(
  purpose: KeyPurpose,
  payload: Record<string, unknown>,
  ttlSeconds: number,
  now?: Date,
): string {
  return signTokenWithKey(appKey(purpose), payload, ttlSeconds, now);
}

export function verifySignedToken<T extends Record<string, unknown>>(
  purpose: KeyPurpose,
  token: string | null | undefined,
  now?: Date,
): (T & { exp: number }) | null {
  return verifyTokenWithKey<T>(appKey(purpose), token, now);
}

// ---------------------------------------------------------------- form age (spec §7 Abuse)

/** Hidden-field token recording when a public form was rendered. Valid for 24 h. */
export function issueFormStartToken(now: Date = new Date()): string {
  return signToken("form-start", { t: now.getTime() }, 24 * 60 * 60, now);
}

/** Milliseconds since the form was rendered, or null when the token is missing/forged/expired. */
export function formAgeMs(
  token: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const payload = verifySignedToken<{ t: number }>("form-start", token, now);
  if (!payload || typeof payload.t !== "number") return null;
  return now.getTime() - payload.t;
}
