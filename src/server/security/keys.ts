import "server-only";
import { env } from "@/server/env";
import { deriveKey } from "./crypto";

/** Purposes for HKDF sub-keys of `APP_SECRET`. One key per purpose; never reuse across purposes. */
export type KeyPurpose =
  | "cardcom-notify"
  | "return"
  | "order-access"
  | "file-url"
  | "form-start"
  | "cancel-review"
  | "ip-hash"
  | "rate-limit"
  | "audit-subject";

const cache = new Map<KeyPurpose, Buffer>();

/** HKDF-SHA256(APP_SECRET, purpose), cached per process. */
export function appKey(purpose: KeyPurpose): Buffer {
  let key = cache.get(purpose);
  if (!key) {
    key = deriveKey(env.APP_SECRET, purpose);
    cache.set(purpose, key);
  }
  return key;
}

/** The PII encryption key (AES-256-GCM), decoded and validated by `env.ts`. */
export function piiKey(): Buffer {
  return env.PII_ENCRYPTION_KEY_BYTES;
}
