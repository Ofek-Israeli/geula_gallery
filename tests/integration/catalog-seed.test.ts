import { stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getArtworkPage,
  getDeliveryEstimates,
  getFeaturedArtwork,
  listArtworks,
  listCredits,
  listRecentlySold,
} from "@/server/catalog/queries";
import { db } from "@/server/db/client";
import { artworkImages, artworks, sales } from "@/server/db/schema";
import { catalogSeed } from "../../scripts/seed/catalog";
import { ordersSeed } from "../../scripts/seed/orders";
import type { SeedContext } from "../../scripts/seed/types";
import { resetDatabase } from "../helpers/db";

/** The M2 demo catalog seed and the public catalog queries over it (spec §8.3, §8.4, §6.2). */
const STORAGE_DIR = ".data/test-uploads";
const ctx: SeedContext = {
  db,
  mode: "demo",
  env: {
    authBaseUrl: "http://localhost:3000",
    seedE2eUsers: false,
    e2eAdminPassword: "e2e-admin-password",
    storageDriver: "local",
    storageDir: STORAGE_DIR,
  },
  log: () => {},
};

beforeAll(async () => {
  await resetDatabase();
  await catalogSeed.run(ctx);
  await ordersSeed.run(ctx);
}, 120_000);

describe("catalog seed", () => {
  it("inserts 16 published demo works with one MAIN image each and stored files", async () => {
    const rows = await db.select().from(artworks);
    expect(rows).toHaveLength(16);
    expect(rows.every((r) => r.isDemo && r.isPublished)).toBe(true);
    const images = await db.select().from(artworkImages);
    expect(images).toHaveLength(16);
    for (const img of images) {
      expect(img.role).toBe("MAIN");
      expect(img.altHe).not.toBe("");
      expect(img.altEn).not.toBe("");
      await stat(path.join(STORAGE_DIR, "public", img.publicKey));
      await stat(path.join(STORAGE_DIR, "private", img.originalKey ?? ""));
    }
  });

  it("sets the demo statuses: 3 sold through OFFLINE mock sales, 1 on hold, 1 NFS", async () => {
    const rows = await db
      .select({ slug: artworks.slug, status: artworks.saleStatus })
      .from(artworks);
    const by = (s: string) =>
      rows
        .filter((r) => r.status === s)
        .map((r) => r.slug)
        .sort();
    expect(by("SOLD")).toEqual([
      "moonrise",
      "terrace-bridge-central-park",
      "the-red-room-etretat",
    ]);
    expect(by("ON_HOLD")).toEqual(["boats-at-rest"]);
    expect(by("NOT_FOR_SALE")).toEqual(["interior-music-room"]);
    const s = await db.select().from(sales);
    expect(s).toHaveLength(3);
    expect(s.every((x) => x.channel === "OFFLINE" && x.isMock)).toBe(true);
  });

  it("is idempotent", async () => {
    await catalogSeed.run(ctx);
    await ordersSeed.run(ctx);
    expect(await db.$count(artworks)).toBe(16);
    expect(await db.$count(artworkImages)).toBe(16);
    expect(await db.$count(sales)).toBe(3);
  });

  it("stores the packaging defaults (icebound ships rolled)", async () => {
    const [ice] = await db
      .select()
      .from(artworks)
      .where(eq(artworks.slug, "icebound"));
    expect(ice).toMatchObject({
      packagingType: "ROLLED_TUBE",
      packedLengthMm: 742,
      packedWidthMm: 260,
      packedHeightMm: 260,
      packedWeightG: 4451,
    });
  });
});

describe("catalog queries", () => {
  it("lists available works first and keeps sold works in the archive", async () => {
    const current = await listArtworks("en");
    expect(current.total).toBe(13);
    expect(current.items[0]?.state.kind).toBe("available");
    expect(current.items.at(-1)?.saleStatus).not.toBe("AVAILABLE");
    const sold = await listArtworks("he", { view: "sold" });
    expect(sold.total).toBe(3);
    expect(sold.items[0]?.slug).toBe("terrace-bridge-central-park");
    expect(sold.items[0]?.title).toBe("גשר הטרסה");
    const recent = await listRecentlySold("en");
    expect(recent.map((w) => w.slug)).toEqual([
      "terrace-bridge-central-park",
      "moonrise",
      "the-red-room-etretat",
    ]);
  });

  it("returns the featured work and a full artwork page", async () => {
    const featured = await getFeaturedArtwork("en");
    expect(featured?.slug).toBe("at-the-rivers-bend");
    const page = await getArtworkPage("en", "landscape-no-26");
    expect(page?.artwork).toMatchObject({
      title: "Landscape no. 26",
      price: { ilsMinor: 320_000, usdMinor: 87_000, onRequest: false },
      state: { kind: "available", buyable: true },
      series: { slug: "landscapes", name: "Landscapes" },
    });
    expect(page?.artwork.images[0]?.src).toMatch(
      /^\/api\/files\/public\/artworks\/demo\//,
    );
    expect(await getArtworkPage("en", "nope")).toBeNull();
    const held = await getArtworkPage("he", "boats-at-rest");
    expect(held?.artwork.state).toEqual({
      kind: "on_hold",
      reservedOffline: true,
    });
    const crate = await getArtworkPage("en", "banks-of-the-durance");
    expect(crate?.artwork.state).toEqual({ kind: "available", buyable: false });
  });

  it("computes delivery estimates from the shipping settings", async () => {
    const page = await getArtworkPage("en", "landscape-no-26");
    if (!page) throw new Error("missing");
    const d = await getDeliveryEstimates(
      "en",
      page.shipSpec,
      new Date("2026-10-01T09:00:00Z"),
    );
    expect(d.pickupFree).toBe(true);
    expect(d.zones.find((z) => z.zone === "IL")).toMatchObject({
      kind: "price",
      fromIlsMinor: 6000,
      insured: false,
    });
    expect(d.zones.find((z) => z.zone === "EUROPE")?.kind).toBe("quote");
  });

  it("lists AIC credits", async () => {
    const credits = await listCredits("en");
    expect(credits).toHaveLength(16);
    expect(credits[0]?.caption).toBe(
      "Marsden Hartley. Landscape no. 26, 1909–10. The Art Institute of Chicago.",
    );
  });
});
