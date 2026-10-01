import "server-only";
import { del, get, put } from "@vercel/blob";
import { ProviderNotConfiguredError } from "@/server/integrations/http";
import { assertSafeKey, encodeKeyPath, signedPrivateFileUrl } from "./keys";
import {
  IMMUTABLE_CACHE_CONTROL,
  type PutOptions,
  type StorageAccess,
  type StorageAdapter,
  type StoredObject,
} from "./types";

/**
 * Vercel Blob driver (@vercel/blob 2.8.0, spec §4.6): a public store for web masters and OG images
 * and a private store for everything else. Private objects are still served through our own
 * `/api/files/private/<key>` route (admin session or signed URL), which streams from the store.
 * Not exercised locally (deploy guide only); the local driver is the tested path.
 */
export interface BlobStorageOptions {
  publicToken?: string;
  privateToken?: string;
  /** `<id>.public.blob.vercel-storage.com` */
  publicHost?: string;
}

const ONE_YEAR_SEC = 31_536_000;

export function createBlobStorage(opts: BlobStorageOptions): StorageAdapter {
  function tokenFor(access: StorageAccess): string {
    const token = access === "public" ? opts.publicToken : opts.privateToken;
    if (!token) {
      throw new ProviderNotConfiguredError(
        "blob",
        `missing ${access === "public" ? "BLOB_READ_WRITE_TOKEN" : "BLOB_PRIVATE_READ_WRITE_TOKEN"}`,
      );
    }
    return token;
  }

  return {
    driver: "blob",

    async put(key: string, body: Uint8Array, o: PutOptions) {
      assertSafeKey(key);
      await put(key, Buffer.from(body), {
        access: o.access,
        token: tokenFor(o.access),
        contentType: o.contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge:
          o.access === "public" &&
          (o.cacheControl ?? IMMUTABLE_CACHE_CONTROL).includes("immutable")
            ? ONE_YEAR_SEC
            : 60,
      });
      return { key, size: body.byteLength };
    },

    async get(
      key: string,
      access: StorageAccess,
    ): Promise<StoredObject | null> {
      assertSafeKey(key);
      const result = await get(key, { access, token: tokenFor(access) });
      if (result?.statusCode !== 200) return null;
      return {
        body: result.stream,
        contentType: result.blob.contentType,
        size: result.blob.size,
      };
    },

    async delete(key: string, access: StorageAccess) {
      assertSafeKey(key);
      await del(key, { token: tokenFor(access) });
    },

    publicUrl(key: string) {
      if (!opts.publicHost) {
        throw new ProviderNotConfiguredError(
          "blob",
          "missing NEXT_PUBLIC_BLOB_HOST",
        );
      }
      return `https://${opts.publicHost}/${encodeKeyPath(key)}`;
    },

    signedPrivateUrl(key: string, ttlSec: number) {
      return signedPrivateFileUrl(key, ttlSec);
    },
  };
}
