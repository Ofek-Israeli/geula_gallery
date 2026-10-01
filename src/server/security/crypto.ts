import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Crypto primitives (spec §7). Pure functions take keys explicitly so they are unit-testable;
 * env-bound helpers live in `tokens.ts`, `ip.ts` and `pii.ts` callers.
 */

const HKDF_SALT = "geula-gallery/v1";

/** HKDF-SHA256 sub-key for a purpose label (e.g. `'return'`, `'cardcom-notify'`, `'ip-hash'`). */
export function deriveKey(secret: string, label: string, length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, label, length));
}

export function hmacSha256(
  key: Buffer | string,
  data: string | Buffer,
): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function hmacHex(key: Buffer | string, data: string | Buffer): string {
  return hmacSha256(key, data).toString("hex");
}

export function hmacBase64Url(
  key: Buffer | string,
  data: string | Buffer,
): string {
  return hmacSha256(key, data).toString("base64url");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time string comparison (lengths are hidden by comparing digests). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const GCM_VERSION = "v1";

/**
 * AES-256-GCM encryption for PII at rest (cancellation ID numbers; spec §7 PII).
 * Output: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). `aad` binds the value to its row/column.
 */
export function encryptAesGcm(
  key: Buffer,
  plaintext: string,
  aad?: string,
): string {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [GCM_VERSION, iv, tag, ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptAesGcm(
  key: Buffer,
  payload: string,
  aad?: string,
): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== GCM_VERSION || !iv || !tag || ct === undefined) {
    throw new Error("malformed ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
