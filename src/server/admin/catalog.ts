import "server-only";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { SaleStatus } from "@/lib/catalog";
import { type ChecklistItem, publishChecklist } from "@/server/catalog/publish";
import { shipSpecOf } from "@/server/checkout/pricing";
import { ordersWithAttemptInFlight } from "@/server/checkout/reservations";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  type Artwork,
  type ArtworkImage,
  artworkImages,
  artworks,
  orders,
  type Sale,
  sales,
  series,
} from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { getSetting } from "@/server/settings";
import { classify, zoneEstimates } from "@/server/shipping/rates";
import type {
  ClassifyResult,
  ZoneEstimate,
  ZoneId,
} from "@/server/shipping/types";
import { storage } from "@/server/storage";

/**
 * Admin read model for artworks (spec §6.10 `/admin/artworks`, `/[id]`). WS4-owned module (the
 * spec tree names no file for admin reads; public reads stay in `catalog/queries.ts`, WS1).
 */
export const ADMIN_ARTWORKS_PAGE_SIZE = 50;

export interface AdminArtworkRow {
  id: string;
  slug: string;
  inventoryNumber: string;
  titleHe: string;
  titleEn: string;
  saleStatus: SaleStatus;
  holdReason: Artwork["holdReason"];
  isPublished: boolean;
  isDemo: boolean;
  priceIlsMinor: number | null;
  priceOnRequest: boolean;
  quoteOnly: boolean;
  reservedUntil: Date | null;
  thumb: string | null;
  updatedAt: Date;
}

export type AdminArtworkFilter =
  | "all"
  | "draft"
  | "available"
  | "on_hold"
  | "sold"
  | "not_for_sale";

export async function listAdminArtworks(
  _ctx: AdminContext,
  opts: { filter?: AdminArtworkFilter; q?: string; page?: number } = {},
  db: DbOrTx = defaultDb,
): Promise<{ rows: AdminArtworkRow[]; total: number; page: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const q = opts.q?.trim();
  const f = opts.filter ?? "all";
  const where = and(
    f === "draft" ? eq(artworks.isPublished, false) : undefined,
    f === "available" ? eq(artworks.saleStatus, "AVAILABLE") : undefined,
    f === "on_hold" ? eq(artworks.saleStatus, "ON_HOLD") : undefined,
    f === "sold" ? eq(artworks.saleStatus, "SOLD") : undefined,
    f === "not_for_sale" ? eq(artworks.saleStatus, "NOT_FOR_SALE") : undefined,
    q
      ? or(
          ilike(artworks.titleHe, `%${q}%`),
          ilike(artworks.titleEn, `%${q}%`),
          ilike(artworks.slug, `%${q}%`),
          ilike(artworks.inventoryNumber, `%${q}%`),
        )
      : undefined,
  );
  const rows = await db
    .select({
      id: artworks.id,
      slug: artworks.slug,
      inventoryNumber: artworks.inventoryNumber,
      titleHe: artworks.titleHe,
      titleEn: artworks.titleEn,
      saleStatus: artworks.saleStatus,
      holdReason: artworks.holdReason,
      isPublished: artworks.isPublished,
      isDemo: artworks.isDemo,
      priceIlsMinor: artworks.priceIlsMinor,
      priceOnRequest: artworks.priceOnRequest,
      quoteOnly: artworks.quoteOnly,
      reservedUntil: artworks.reservedUntil,
      thumbKey: artworkImages.publicKey,
      updatedAt: artworks.updatedAt,
    })
    .from(artworks)
    .leftJoin(
      artworkImages,
      and(
        eq(artworkImages.artworkId, artworks.id),
        eq(artworkImages.role, "MAIN"),
      ),
    )
    .where(where)
    .orderBy(
      asc(artworks.isPublished),
      sql`CASE ${artworks.saleStatus} WHEN 'AVAILABLE' THEN 0 WHEN 'ON_HOLD' THEN 1 WHEN 'NOT_FOR_SALE' THEN 2 ELSE 3 END`,
      desc(artworks.updatedAt),
      asc(artworks.id),
    )
    .limit(ADMIN_ARTWORKS_PAGE_SIZE)
    .offset((page - 1) * ADMIN_ARTWORKS_PAGE_SIZE);
  const [total] = await db.select({ n: count() }).from(artworks).where(where);
  const store = storage();
  return {
    rows: rows.map(({ thumbKey, ...r }) => ({
      ...r,
      thumb: thumbKey ? store.publicUrl(thumbKey) : null,
    })),
    total: total?.n ?? 0,
    page,
  };
}

export interface AdminArtworkImage extends ArtworkImage {
  src: string;
}

export interface AdminArtworkDetail {
  artwork: Artwork;
  images: AdminArtworkImage[];
  series: { id: string; nameHe: string; nameEn: string }[];
  checklist: ChecklistItem[];
  activeSale: Sale | null;
  /** The order holding the work (live or lapsed), when any. */
  hold: {
    orderId: string;
    orderNumber: string | null;
    until: Date;
    live: boolean;
    inFlight: boolean;
  } | null;
  shipping: {
    classified: ClassifyResult;
    estimates: Record<ZoneId, ZoneEstimate>;
    /** Packed values are missing: the class uses the engine's defaults. */
    usesDefaults: boolean;
  };
}

export async function getAdminArtwork(
  _ctx: AdminContext,
  id: string,
  db: DbOrTx = defaultDb,
): Promise<AdminArtworkDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [artwork] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!artwork) return null;
  const images = await db
    .select()
    .from(artworkImages)
    .where(eq(artworkImages.artworkId, id))
    .orderBy(asc(artworkImages.sortOrder), asc(artworkImages.createdAt));
  const seriesRows = await db
    .select({ id: series.id, nameHe: series.nameHe, nameEn: series.nameEn })
    .from(series)
    .orderBy(asc(series.sortOrder), asc(series.nameEn));
  const [activeSale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.artworkId, id), isNull(sales.voidedAt)));
  let hold: AdminArtworkDetail["hold"] = null;
  if (artwork.reservedByOrderId && artwork.reservedUntil) {
    const [o] = await db
      .select({ number: orders.number })
      .from(orders)
      .where(eq(orders.id, artwork.reservedByOrderId));
    const inFlight =
      (await ordersWithAttemptInFlight(db, [artwork.reservedByOrderId])).size >
      0;
    hold = {
      orderId: artwork.reservedByOrderId,
      orderNumber: o?.number ?? null,
      until: artwork.reservedUntil,
      live: inFlight || artwork.reservedUntil.getTime() > Date.now(),
      inFlight,
    };
  }
  const settings = await getSetting("shipping", db);
  const spec = shipSpecOf(artwork);
  const store = storage();
  return {
    artwork,
    images: images.map((i) => ({ ...i, src: store.publicUrl(i.publicKey) })),
    series: seriesRows,
    checklist: publishChecklist(artwork, images),
    activeSale: activeSale ?? null,
    hold,
    shipping: {
      classified: classify(spec, settings.divisor),
      estimates: zoneEstimates(spec, settings, new Date()),
      usesDefaults:
        artwork.packedLengthMm === null ||
        artwork.packedWidthMm === null ||
        artwork.packedHeightMm === null ||
        artwork.packedWeightG === null,
    },
  };
}
