import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getArtworkOgImage,
  getArtworkPage,
  getPublicProfile,
  listArtworks,
  listSeries,
  listSitemapArtworks,
} from "@/server/catalog/queries";
import { db } from "@/server/db/client";
import { artworkImages, artworks } from "@/server/db/schema";
import { catalogSeed } from "../../scripts/seed/catalog";
import { ordersSeed } from "../../scripts/seed/orders";
import type { SeedContext } from "../../scripts/seed/types";
import { resetDatabase } from "../helpers/db";

/** WS1 catalog reads over the demo catalog: filters, sorts, series, sitemap, SEO (spec §6.2, §6.6). */
const ctx: SeedContext = {
  db,
  mode: "demo",
  env: {
    authBaseUrl: "http://localhost:3000",
    seedE2eUsers: false,
    e2eAdminPassword: "e2e-admin-password",
    storageDriver: "local",
    storageDir: ".data/test-uploads",
  },
  log: () => {},
};

beforeAll(async () => {
  await resetDatabase();
  await catalogSeed.run(ctx);
  await ordersSeed.run(ctx);
}, 120_000);

const slugs = (page: { items: { slug: string }[] }) =>
  page.items.map((w) => w.slug);

describe("listArtworks filters", () => {
  it("narrows by availability, series, size, orientation and price band", async () => {
    const available = await listArtworks("en", { view: "available" });
    expect(available.total).toBe(11);
    expect(available.items.every((w) => w.saleStatus === "AVAILABLE")).toBe(
      true,
    );

    const paper = await listArtworks("en", { seriesSlug: "works-on-paper" });
    // terrace-bridge is sold, so only Antibes is in the current view.
    expect(slugs(paper)).toEqual(["antibes"]);
    expect(
      slugs(
        await listArtworks("en", {
          view: "sold",
          seriesSlug: "works-on-paper",
        }),
      ),
    ).toEqual(["terrace-bridge-central-park"]);
    expect(
      (await listArtworks("en", { seriesSlug: "no-such-series" })).total,
    ).toBe(0);

    const small = await listArtworks("en", { sizeBucket: "S" });
    expect(new Set(slugs(small))).toEqual(
      new Set(["landscape-no-26", "still-life-green-flower-vase"]),
    );
    const pano = await listArtworks("en", { orientation: "PANORAMIC" });
    expect(slugs(pano)).toEqual(["banks-of-the-durance"]);

    const cheap = await listArtworks("en", { priceMaxIlsMinor: 500_000 });
    expect(new Set(slugs(cheap))).toEqual(
      new Set(["landscape-no-26", "still-life-green-flower-vase", "antibes"]),
    );
    // The not-for-sale work has no price, so any price band excludes it.
    const band = await listArtworks("en", {
      priceMinIlsMinor: 1_000_000,
      priceMaxIlsMinor: 2_000_000,
    });
    expect(new Set(slugs(band))).toEqual(
      new Set([
        "beach-at-cabasson",
        "boats-at-rest",
        "banks-of-the-durance",
        "a-holiday",
      ]),
    );
  });

  it("sorts by price and size, keeping available works first in the current view", async () => {
    const byPrice = await listArtworks("en", { sort: "price-desc" });
    const statuses = byPrice.items.map((w) => w.saleStatus);
    const firstOther = statuses.findIndex((s) => s !== "AVAILABLE");
    expect(statuses.slice(firstOther).every((s) => s !== "AVAILABLE")).toBe(
      true,
    );
    const prices = byPrice.items
      .slice(0, firstOther)
      .map((w) => w.price.ilsMinor ?? 0);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
    expect(byPrice.items[0]?.slug).toBe("banks-of-the-durance");

    const asc = await listArtworks("en", {
      view: "available",
      sort: "price-asc",
    });
    expect(asc.items[0]?.slug).toBe("antibes");

    const bigFirst = await listArtworks("en", {
      view: "available",
      sort: "size-desc",
    });
    expect(bigFirst.items[0]?.slug).toBe("banks-of-the-durance");
    const areas = bigFirst.items.map((w) => w.heightMm * w.widthMm);
    expect(areas).toEqual([...areas].sort((a, b) => b - a));

    const newest = await listArtworks("en", {
      view: "available",
      sort: "newest",
    });
    expect(newest.items[0]?.year).toBe(1917);
  });

  it("paginates with a stable order", async () => {
    const p1 = await listArtworks("en", { pageSize: 5, page: 1 });
    const p2 = await listArtworks("en", { pageSize: 5, page: 2 });
    const p3 = await listArtworks("en", { pageSize: 5, page: 3 });
    const all = [...slugs(p1), ...slugs(p2), ...slugs(p3)];
    expect(all).toHaveLength(13);
    expect(new Set(all).size).toBe(13);
  });
});

describe("series, sitemap and SEO reads", () => {
  it("lists series with counts of unsold works and a cover image", async () => {
    const series = await listSeries("he");
    expect(series.map((s) => s.slug)).toContain("landscapes");
    const landscapes = series.find((s) => s.slug === "landscapes");
    // Five landscapes, one of them (Moonrise) sold.
    expect(landscapes?.count).toBe(4);
    expect(landscapes?.cover?.src).toMatch(/^\/api\/files\/public\//);
    expect(landscapes?.name).not.toBe("Landscapes");
  });

  it("lists every published work for the sitemap and hides unpublished ones", async () => {
    const before = await listSitemapArtworks();
    expect(before).toHaveLength(16);
    expect(before[0]?.images[0]).toMatch(/^\/api\/files\/public\//);
    await db
      .update(artworks)
      .set({ isPublished: false })
      .where(eq(artworks.slug, "antibes"));
    try {
      const after = await listSitemapArtworks();
      expect(after.map((a) => a.slug)).not.toContain("antibes");
      expect(await getArtworkPage("en", "antibes")).toBeNull();
      expect(await getArtworkOgImage("antibes")).toBeNull();
    } finally {
      await db
        .update(artworks)
        .set({ isPublished: true })
        .where(eq(artworks.slug, "antibes"));
    }
  });

  it("falls back to the MAIN image when it has no OG rendition (a promoted DETAIL)", async () => {
    const [main] = await db
      .select()
      .from(artworkImages)
      .innerJoin(artworks, eq(artworks.id, artworkImages.artworkId))
      .where(and(eq(artworks.slug, "antibes"), eq(artworkImages.role, "MAIN")));
    if (!main) throw new Error("no MAIN image");
    const img = main.artwork_images;
    await db
      .update(artworkImages)
      .set({ ogKey: null })
      .where(eq(artworkImages.id, img.id));
    try {
      const og = await getArtworkOgImage("antibes");
      expect(og).toEqual({
        url: expect.stringContaining(img.publicKey),
        width: img.width,
        height: img.height,
      });
      const page = await getArtworkPage("en", "antibes");
      expect(page?.artwork.ogImage).toBe(page?.artwork.images[0]?.src);
    } finally {
      await db
        .update(artworkImages)
        .set({ ogKey: img.ogKey })
        .where(eq(artworkImages.id, img.id));
    }
  });

  it("returns SEO extras, the OG image and the public profile without the ID number", async () => {
    const page = await getArtworkPage("en", "landscape-no-26");
    expect(page?.seo).toMatchObject({ medium: "OIL", surface: "CARDBOARD" });
    expect(await getArtworkOgImage("landscape-no-26")).toMatchObject({
      url: expect.stringMatching(/^\/api\/files\/public\/og\//),
      width: 1200,
      height: 630,
    });
    const profile = await getPublicProfile("en");
    expect(Object.keys(profile).sort()).toEqual([
      "artistName",
      "email",
      "phoneIntl",
      "phoneLocal",
      "tradeName",
    ]);
  });
});
