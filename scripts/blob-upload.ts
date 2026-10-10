/**
 * `npm run prod:upload [-- --dir <folder>]` (default `.data/prod-seed`)
 *
 * Copies the images a remote seed wrote locally (`npm run prod:seed`) to the two Vercel Blob
 * stores, under the same keys: `<dir>/public/**` (web masters and OG images) to the public store
 * (`BLOB_READ_WRITE_TOKEN`), `<dir>/private/**` (originals) to the private store
 * (`BLOB_PRIVATE_READ_WRITE_TOKEN`). The put options match `src/server/storage/blob.ts`: no random
 * suffix, overwrite allowed, a year of caching for the public images (their keys are
 * content-derived). Keys already in a store are skipped, so a re-run uploads only what is missing.
 * Prints the public store's host for `NEXT_PUBLIC_BLOB_HOST`.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { list, put } from "@vercel/blob";
import { argValue, requireEnv } from "./lib/db";

type Access = "public" | "private";

const ONE_YEAR_SEC = 31_536_000;
const CONCURRENCY = 6;
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function existingKeys(token: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await list({
      token,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const b of page.blobs) keys.add(b.pathname);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function upload(
  dir: string,
  access: Access,
  token: string,
): Promise<{ uploaded: number; skipped: number; host: string | null }> {
  const root = path.join(dir, access);
  const files = await filesUnder(root);
  const have = await existingKeys(token);
  const todo = files
    .map((file) => ({
      file,
      key: path.relative(root, file).split(path.sep).join("/"),
    }))
    .filter(({ key }) => !have.has(key));
  let host: string | null = null;
  let next = 0;
  let uploaded = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { file, key } = todo[next++] as (typeof todo)[number];
      const contentType =
        CONTENT_TYPES[path.extname(key).toLowerCase()] ??
        "application/octet-stream";
      const body = await readFile(file);
      for (let attempt = 1; ; attempt++) {
        try {
          const blob = await put(key, body, {
            access,
            token,
            contentType,
            addRandomSuffix: false,
            allowOverwrite: true,
            cacheControlMaxAge: access === "public" ? ONE_YEAR_SEC : 60,
          });
          host ??= new URL(blob.url).host;
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      uploaded++;
      if (uploaded % 25 === 0) {
        console.log(`[blob-upload] ${access}: ${uploaded}/${todo.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { uploaded, skipped: files.length - todo.length, host };
}

const dir = argValue(process.argv.slice(2), "--dir") ?? ".data/prod-seed";
const publicToken = requireEnv("BLOB_READ_WRITE_TOKEN");
const privateToken = requireEnv("BLOB_PRIVATE_READ_WRITE_TOKEN");

const pub = await upload(dir, "public", publicToken);
console.log(
  `[blob-upload] public: ${pub.uploaded} uploaded, ${pub.skipped} already there`,
);
const priv = await upload(dir, "private", privateToken);
console.log(
  `[blob-upload] private: ${priv.uploaded} uploaded, ${priv.skipped} already there`,
);
if (pub.host) {
  console.log(`[blob-upload] NEXT_PUBLIC_BLOB_HOST=${pub.host}`);
} else if (pub.uploaded === 0) {
  // Nothing new was uploaded: read the host from an existing public blob.
  const page = await list({ token: publicToken, limit: 1 });
  const first = page.blobs[0];
  if (first) {
    console.log(
      `[blob-upload] NEXT_PUBLIC_BLOB_HOST=${new URL(first.url).host}`,
    );
  }
}
