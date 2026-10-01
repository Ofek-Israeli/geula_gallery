import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  env: {
    APP_SECRET: "test-app-secret-at-least-32-characters-long",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: ".data/test-uploads",
    isProduction: false,
  },
}));

const keys = await import("@/server/storage/keys");
const { createLocalStorage } = await import("@/server/storage/local");

const root = await mkdtemp(path.join(tmpdir(), "gg-storage-"));
afterAll(() => rm(root, { recursive: true, force: true }));

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("storage keys", () => {
  it("accepts normal keys and rejects traversal and odd segments", () => {
    expect(keys.isSafeKey("artworks/abc/1234-x.jpg")).toBe(true);
    for (const bad of [
      "",
      "/etc/passwd",
      "../secret",
      "a/../b",
      "a//b",
      "a/./b",
      "a\\b",
      ".hidden",
      "a/b c.jpg",
      "a/%2e%2e/b",
      "x".repeat(600),
    ]) {
      expect(keys.isSafeKey(bad), bad).toBe(false);
    }
  });

  it("decodes route segments and refuses encoded traversal", () => {
    expect(keys.keyFromSegments(["artworks", "a", "b.jpg"])).toBe(
      "artworks/a/b.jpg",
    );
    expect(keys.keyFromSegments(["%2e%2e", "x"])).toBeNull();
    expect(keys.keyFromSegments(["a%2F..%2Fb"])).toBeNull();
  });

  it("infers content types from the extension", () => {
    expect(keys.contentTypeForKey("a/b.JPG")).toBe("image/jpeg");
    expect(keys.contentTypeForKey("a/b.pdf")).toBe("application/pdf");
    expect(keys.contentTypeForKey("a/b")).toBe("application/octet-stream");
  });

  it("makes per-purpose private keys and unique artwork keys", () => {
    const k = keys.newPrivatePhotoKey(
      "packing",
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(k).toMatch(/^packing\/2026\/10\/[0-9a-f-]{36}\.jpg$/);
    const a = keys.artworkImageKeys("art-1", "f".repeat(64), "png");
    const b = keys.artworkImageKeys("art-1", "f".repeat(64), "png");
    expect(a.master).not.toBe(b.master);
    expect(a.original).toMatch(/^originals\/art-1\/f{12}-[0-9a-f]{8}\.png$/);
    expect(keys.isSafeKey(a.og)).toBe(true);
  });

  it("signs private URLs that expire within 10 minutes and are key-bound", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    const t = keys.signPrivateFileToken("packing/a.jpg", 3600, now);
    expect(keys.verifyPrivateFileToken("packing/a.jpg", t, now)).toBe(true);
    expect(keys.verifyPrivateFileToken("packing/b.jpg", t, now)).toBe(false);
    // ttl is capped at 600 s even when more is asked for
    const later = new Date(now.getTime() + 601_000);
    expect(keys.verifyPrivateFileToken("packing/a.jpg", t, later)).toBe(false);
    expect(
      keys.verifyPrivateFileToken("packing/a.jpg", "forged.sig", now),
    ).toBe(false);
    expect(keys.signedPrivateFileUrl("packing/a.jpg", 60)).toMatch(
      /^\/api\/files\/private\/packing\/a\.jpg\?t=/,
    );
  });
});

describe("local storage driver", () => {
  const store = createLocalStorage(root);

  it("round-trips public and private objects in separate roots", async () => {
    const body = new TextEncoder().encode("hello");
    await store.put("a/b.txt", body, {
      access: "private",
      contentType: "text/plain",
    });
    expect(await store.get("a/b.txt", "public")).toBeNull();
    const got = await store.get("a/b.txt", "private");
    expect(got?.size).toBe(5);
    expect(got?.contentType).toBe("text/plain; charset=utf-8");
    expect(await readAll(got?.body as ReadableStream<Uint8Array>)).toBe(
      "hello",
    );
    expect(await readdir(path.join(root, "private", "a"))).toEqual(["b.txt"]);
    await store.delete("a/b.txt", "private");
    expect(await store.get("a/b.txt", "private")).toBeNull();
  });

  it("rejects path traversal on write and returns null on read", async () => {
    await expect(
      store.put("../escape.txt", new Uint8Array([1]), {
        access: "public",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("invalid storage key");
    expect(await store.get("../../etc/passwd", "public")).toBeNull();
  });

  it("builds relative public URLs", () => {
    expect(store.publicUrl("artworks/x/y.jpg")).toBe(
      "/api/files/public/artworks/x/y.jpg",
    );
  });
});
