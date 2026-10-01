/**
 * RFC 6238 TOTP for tests (spec §10.4 `admin-auth`, `admin-security`; frozen at contracts-v1).
 *
 * Better Auth's two-factor plugin puts `base32(secret)` in the `otpauth://` URI and signs with
 * HMAC-SHA1 over the raw secret bytes, 30 s period, 6 digits — the standard parameters, so the
 * base32 secret shown on `/admin/enroll-2fa` (or the URI) is all a test needs.
 */
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 decode (case-insensitive; padding and spaces ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4648 base32 encode without padding (for building fixtures). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpOptions {
  /** Unix milliseconds (default: now). */
  at?: number;
  period?: number;
  digits?: number;
}

/** Current TOTP code for a base32 secret. */
export function totp(base32Secret: string, opts: TotpOptions = {}): string {
  const period = opts.period ?? 30;
  const counter = Math.floor((opts.at ?? Date.now()) / 1000 / period);
  return hotp(base32Decode(base32Secret), counter, opts.digits ?? 6);
}

/** The base32 `secret` parameter of an `otpauth://totp/...` URI. */
export function secretFromTotpUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("otpauth URI has no secret");
  return secret;
}

/**
 * Milliseconds until the current 30 s window ends. Wait this long before submitting a code when
 * fewer than ~3 s remain, so the code is not rejected for crossing a window boundary.
 */
export function msUntilNextWindow(period = 30, at = Date.now()): number {
  return period * 1000 - (at % (period * 1000));
}
