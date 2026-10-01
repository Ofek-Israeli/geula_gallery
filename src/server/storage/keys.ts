import "server-only";
import { randomUUID } from "node:crypto";
import { signToken, verifySignedToken } from "@/server/security/tokens";
import { MAX_SIGNED_URL_TTL_SEC } from "./types";

/**
 * Storage key rules and signed private URLs (spec §4.6, §7). Pure apart from the HKDF key.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_KEY_LENGTH = 512;

export class InvalidStorageKeyError extends Error {
  constructor() {
    super("invalid storage key");
    this.name = "InvalidStorageKeyError";
  }
}

/** True for `a/b/c.jpg`; false for traversal, absolute paths, empty or odd segments. */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH) return false;
  if (key.startsWith("/") || key.includes("\\")) return false;
  return key.split("/").every((s) => SEGMENT.test(s) && !s.includes(".."));
}

export function assertSafeKey(key: string): string {
  if (!isSafeKey(key)) throw new InvalidStorageKeyError();
  return key;
}

/** Joins route segments (`[...key]`) into a key, or null when unsafe. */
export function keyFromSegments(segments: readonly string[]): string | null {
  const key = segments.map((s) => decodeURIComponent(s)).join("/");
  return isSafeKey(key) ? key : null;
}

/** URL-encodes each segment of a safe key for use in a path. */
export function encodeKeyPath(key: string): string {
  return assertSafeKey(key).split("/").map(encodeURIComponent).join("/");
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
};

export function contentTypeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export type UploadPurpose = "artwork" | "packing" | "return";

/** New, unguessable keys per purpose. `yyyy/mm` keeps local directories small. */
export function newPrivatePhotoKey(
  purpose: Exclude<UploadPurpose, "artwork">,
  now: Date = new Date(),
): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${purpose}/${yyyy}/${mm}/${randomUUID()}.jpg`;
}

export interface ArtworkImageKeys {
  master: string;
  original: string;
  og: string;
}

/**
 * Keys for one artwork upload. The stem is a content-hash prefix plus a random suffix, so a
 * re-upload of the same file never shares (or deletes) another row's objects.
 */
export function artworkImageKeys(
  artworkId: string,
  contentHash: string,
  originalExt: "jpg" | "png" | "webp",
): ArtworkImageKeys {
  const h = `${contentHash.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  return {
    master: `artworks/${artworkId}/${h}.jpg`,
    original: `originals/${artworkId}/${h}.${originalExt}`,
    og: `og/${artworkId}/${h}.jpg`,
  };
}

// ---------------------------------------------------------------- signed private URLs

export function privateFilePath(key: string): string {
  return `/api/files/private/${encodeKeyPath(key)}`;
}

export function signPrivateFileToken(
  key: string,
  ttlSec: number,
  now?: Date,
): string {
  const ttl = Math.min(Math.max(1, Math.floor(ttlSec)), MAX_SIGNED_URL_TTL_SEC);
  return signToken("file-url", { k: assertSafeKey(key) }, ttl, now);
}

export function verifyPrivateFileToken(
  key: string,
  token: string | null | undefined,
  now?: Date,
): boolean {
  const payload = verifySignedToken<{ k: string }>("file-url", token, now);
  return payload !== null && payload.k === key;
}

export function signedPrivateFileUrl(key: string, ttlSec: number): string {
  return `${privateFilePath(key)}?t=${encodeURIComponent(signPrivateFileToken(key, ttlSec))}`;
}
