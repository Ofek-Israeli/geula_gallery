/**
 * A seed-side `StorageAdapter` for the local driver (spec §4.6 layout:
 * `<LOCAL_STORAGE_DIR>/{public,private}/<key>`, atomic temp-file + rename writes).
 *
 * Seeds must not import `src/server/env.ts` (directly or through `@/server/storage`, whose key
 * signing reads `APP_SECRET`), so this adapter re-implements the few write/read operations the
 * catalog seed needs. Files it writes are served by the app's `/api/files/public/<key>` route
 * exactly like uploads. Signed private URLs are not available here.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  PutOptions,
  StorageAccess,
  StorageAdapter,
  StoredObject,
} from "@/server/storage/types";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertKey(key: string): void {
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\\") ||
    !key.split("/").every((s) => SEGMENT.test(s) && !s.includes(".."))
  ) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

export function createSeedStorage(rootDir: string): StorageAdapter {
  const root = path.resolve(rootDir);
  const fileFor = (key: string, access: StorageAccess) => {
    assertKey(key);
    return path.join(root, access, key);
  };
  return {
    driver: "local",
    async put(key: string, body: Uint8Array, opts: PutOptions) {
      const file = fileFor(key, opts.access);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, file);
      return { key, size: body.byteLength };
    },
    async get(
      key: string,
      access: StorageAccess,
    ): Promise<StoredObject | null> {
      const file = fileFor(key, access);
      try {
        const s = await stat(file);
        return {
          body: Readable.toWeb(
            createReadStream(file),
          ) as ReadableStream<Uint8Array>,
          contentType: "application/octet-stream",
          size: s.size,
        };
      } catch {
        return null;
      }
    },
    async delete(key: string, access: StorageAccess) {
      await rm(fileFor(key, access), { force: true });
    },
    publicUrl(key: string) {
      assertKey(key);
      return `/api/files/public/${key.split("/").map(encodeURIComponent).join("/")}`;
    },
    signedPrivateUrl() {
      throw new Error("signed private URLs are not available in seeds");
    },
  };
}
