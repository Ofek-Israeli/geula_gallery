import { readFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import { orientationOf, sizeBucketOf } from "@/lib/dimensions";
import { artworkImages, artworks, series } from "@/server/db/schema";
import { ingestArtworkImage } from "@/server/media/ingest";
import {
  IMMUTABLE_CACHE_CONTROL,
  type StorageAdapter,
} from "@/server/storage/types";
import { type DemoManifestWork, readDemoManifest } from "../lib/demo-manifest";
import { demoPackaging } from "./packaging";
import { createSeedStorage } from "./storage";
import type { SeedDb, SeedModule } from "./types";

/**
 * Demo catalog seed (spec §8.3, §8.4; owner M2). Reads `data/demo-manifest.json` (never the AIC
 * API), ingests each committed image through `media/ingest.ts` (web master, private original, OG
 * image, blur, dominant colour) into the local storage directory, and inserts 5 series and the 16
 * demo works (`is_demo = true`, published) with bilingual titles, alt texts and honest demo
 * descriptions, prices, packaging defaults and statuses:
 * - 121377 ON_HOLD (RESERVED_OFFLINE), 270002 NOT_FOR_SALE;
 * - the three sold works are inserted AVAILABLE and marked SOLD by `orders.ts`.
 *
 * Idempotent: series and works are inserted with `ON CONFLICT (slug) DO NOTHING` (existing rows,
 * including the painter's edits, are left alone); image files use content-derived keys, so a
 * re-run rewrites the same objects instead of piling up copies.
 */

function imageKeys(w: DemoManifestWork, hash: string) {
  const stem = `${w.aicId}-${hash.slice(0, 12)}`;
  return {
    master: `artworks/demo/${stem}.jpg`,
    original: `originals/demo/${stem}.jpg`,
    og: `og/demo/${stem}.jpg`,
  };
}

async function storeImages(store: StorageAdapter, w: DemoManifestWork) {
  const bytes = new Uint8Array(await readFile(w.image.file));
  const img = await ingestArtworkImage(bytes);
  const keys = imageKeys(w, img.contentHash);
  await store.put(keys.original, img.original.body, {
    access: "private",
    contentType: img.original.contentType,
  });
  await store.put(keys.master, img.master.body, {
    access: "public",
    contentType: "image/jpeg",
    cacheControl: IMMUTABLE_CACHE_CONTROL,
  });
  await store.put(keys.og, img.og.body, {
    access: "public",
    contentType: "image/jpeg",
    cacheControl: IMMUTABLE_CACHE_CONTROL,
  });
  return { img, keys };
}

async function seedSeries(
  db: SeedDb,
  rows: { slug: string; name: { he: string; en: string }; sortOrder: number }[],
): Promise<Map<string, string>> {
  await db
    .insert(series)
    .values(
      rows.map((s) => ({
        slug: s.slug,
        nameHe: s.name.he,
        nameEn: s.name.en,
        sortOrder: s.sortOrder,
      })),
    )
    .onConflictDoNothing({ target: series.slug });
  const all = await db
    .select({ id: series.id, slug: series.slug })
    .from(series)
    .where(
      inArray(
        series.slug,
        rows.map((s) => s.slug),
      ),
    );
  return new Map(all.map((s) => [s.slug, s.id]));
}

export const catalogSeed: SeedModule = {
  name: "catalog",
  modes: ["demo"],
  async run({ db, env, log }) {
    if ((env.storageDriver ?? "local") !== "local") {
      throw new Error(
        "catalog seed: the demo catalog can only be seeded with STORAGE_DRIVER=local",
      );
    }
    const store = createSeedStorage(env.storageDir ?? ".data/uploads");
    const manifest = await readDemoManifest();
    const seriesIds = await seedSeries(db, manifest.series);
    const now = new Date();
    let inserted = 0;

    for (const w of manifest.works) {
      const { img, keys } = await storeImages(store, w);
      const pack = demoPackaging(w);
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(artworks)
          .values({
            slug: w.slug,
            isDemo: true,
            seriesId: seriesIds.get(w.series) ?? null,
            titleHe: w.title.he,
            titleEn: w.title.en,
            descriptionHe: w.description.he,
            descriptionEn: w.description.en,
            yearCreated: w.yearCreated,
            medium: w.medium,
            surface: w.surface,
            mediumDetailHe: w.mediumDetail.he,
            mediumDetailEn: w.mediumDetail.en,
            heightMm: w.heightMm,
            widthMm: w.widthMm,
            depthMm: pack.depthMm,
            framed: false,
            glazing: "NONE",
            readyToHang: w.surface === "CANVAS" && !w.canBeRolled,
            signed: false,
            paintedEdges: false,
            coaIncluded: true,
            orientation: orientationOf(w.heightMm, w.widthMm),
            sizeBucket: sizeBucketOf(w.heightMm, w.widthMm),
            isPublished: true,
            publishedAt: now,
            featured: w.featured,
            sortOrder: w.sortOrder,
            // SOLD works start AVAILABLE; orders.ts records their sale.
            saleStatus:
              w.status === "ON_HOLD" || w.status === "NOT_FOR_SALE"
                ? w.status
                : "AVAILABLE",
            holdReason: w.holdReason,
            priceIlsMinor: w.priceIls === null ? null : w.priceIls * 100,
            priceUsdMinor: w.priceUsd === null ? null : w.priceUsd * 100,
            priceOnRequest: false,
            offersEnabled: false,
            packagingType: pack.packagingType,
            canBeRolled: w.canBeRolled,
            packedLengthMm: pack.packedLengthMm,
            packedWidthMm: pack.packedWidthMm,
            packedHeightMm: pack.packedHeightMm,
            packedWeightG: pack.packedWeightG,
            shipsInternationally: w.shipsInternationally,
            localPickupOnly: false,
            quoteOnly: w.quoteOnly,
            dispatchDays: 5,
            creditLine: w.caption,
          })
          .onConflictDoNothing({ target: artworks.slug })
          .returning({ id: artworks.id });
        if (!row) return false;
        await tx.insert(artworkImages).values({
          artworkId: row.id,
          role: "MAIN",
          sortOrder: 0,
          altHe: w.alt.he,
          altEn: w.alt.en,
          publicKey: keys.master,
          originalKey: keys.original,
          ogKey: keys.og,
          width: img.master.width,
          height: img.master.height,
          bytes: img.master.bytes,
          contentHash: img.contentHash,
          blurDataUrl: img.blurDataUrl,
          dominantColor: img.dominantColor,
          creditLine: w.caption,
        });
        return true;
      });
      if (created) inserted++;
    }

    log(
      `catalog: ${manifest.series.length} series, ${inserted} works inserted, ${manifest.works.length - inserted} already present`,
    );
  },
};
