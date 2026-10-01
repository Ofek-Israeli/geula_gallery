import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { randomToken } from "@/server/security/crypto";
import {
  assertSafeKey,
  contentTypeForKey,
  encodeKeyPath,
  InvalidStorageKeyError,
  signedPrivateFileUrl,
} from "./keys";
import type {
  PutOptions,
  StorageAccess,
  StorageAdapter,
  StoredObject,
} from "./types";

/**
 * Local driver (spec §4.6): `.data/uploads/{public,private}/<key>`. Public files are served by
 * `/api/files/public/<key>` with immutable caching; private ones by `/api/files/private/<key>`.
 * Writes are atomic (temp file + rename). Path traversal is rejected twice: by the key rules and
 * by checking the resolved path stays inside the access root.
 */
export function createLocalStorage(rootDir: string): StorageAdapter {
  const root = path.resolve(rootDir);

  function fileFor(key: string, access: StorageAccess): string {
    assertSafeKey(key);
    const base = path.join(root, access);
    const full = path.resolve(base, key);
    if (!full.startsWith(base + path.sep)) throw new InvalidStorageKeyError();
    return full;
  }

  return {
    driver: "local",

    async put(key: string, body: Uint8Array, opts: PutOptions) {
      const file = fileFor(key, opts.access);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomToken(6)}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, file);
      return { key, size: body.byteLength };
    },

    async get(
      key: string,
      access: StorageAccess,
    ): Promise<StoredObject | null> {
      let file: string;
      try {
        file = fileFor(key, access);
      } catch {
        return null;
      }
      try {
        const s = await stat(file);
        if (!s.isFile()) return null;
        return {
          body: Readable.toWeb(
            createReadStream(file),
          ) as ReadableStream<Uint8Array>,
          contentType: contentTypeForKey(key),
          size: s.size,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async delete(key: string, access: StorageAccess) {
      await rm(fileFor(key, access), { force: true });
    },

    publicUrl(key: string) {
      return `/api/files/public/${encodeKeyPath(key)}`;
    },

    signedPrivateUrl(key: string, ttlSec: number) {
      return signedPrivateFileUrl(key, ttlSec);
    },
  };
}
