import "server-only";

/**
 * Storage contract (spec §4.6). Two access levels:
 * - `public`: web masters and OG images, served with immutable caching;
 * - `private`: originals, labels, invoices, packing/return photos, PDFs and receipts, reachable only
 *   through `/api/files/private/<key>` with an admin session or a signed URL (≤ 10 min).
 *
 * Keys are relative, `/`-separated, ASCII (`[A-Za-z0-9._-]` per segment) and never contain `..`.
 */
export type StorageAccess = "public" | "private";

export interface PutOptions {
  contentType: string;
  access: StorageAccess;
  /** Cache-Control for public objects; private objects are always `private, no-store`. */
  cacheControl?: string;
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  size: number;
}

export interface StorageAdapter {
  readonly driver: "local" | "blob";
  put(
    key: string,
    body: Uint8Array,
    opts: PutOptions,
  ): Promise<{ key: string; size: number }>;
  get(key: string, access: StorageAccess): Promise<StoredObject | null>;
  delete(key: string, access: StorageAccess): Promise<void>;
  /** URL of a public object (relative for the local driver). */
  publicUrl(key: string): string;
  /** Same-origin URL of a private object with an expiring signature (`ttlSec ≤ 600`). */
  signedPrivateUrl(key: string, ttlSec: number): string;
}

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const PRIVATE_CACHE_CONTROL = "private, no-store";
/** Signed private URLs never live longer than this (spec §4.6). */
export const MAX_SIGNED_URL_TTL_SEC = 600;
