import "server-only";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import type {
  ArtworkCardDTO,
  ArtworkDetailDTO,
  ArtworkImageDTO,
  CatalogPage,
  CreditDTO,
  ZoneEstimateDTO,
} from "@/lib/catalog";
import type { Locale } from "@/lib/locale";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworkImages, artworks, series } from "@/server/db/schema";
import { getSetting } from "@/server/settings";
import { zoneEstimates } from "@/server/shipping/rates";
import type { ArtworkShipSpec } from "@/server/shipping/types";
import { storage } from "@/server/storage";
import { commerceColumns, commerceStateOf } from "./commerce-state";

/**
 * Public catalog reads (spec §2.4, §6.2; minimal M2 versions, WS1 adds filters, sorts and SEO).
 * Every function takes `locale` explicitly and reads live state per request (no caching). Only
 * published works are listed.
 */

export const PAGE_SIZE = 24;

const cardColumns = {
  id: artworks.id,
  slug: artworks.slug,
  titleHe: artworks.titleHe,
  titleEn: artworks.titleEn,
  yearCreated: artworks.yearCreated,
  mediumDetailHe: artworks.mediumDetailHe,
  mediumDetailEn: artworks.mediumDetailEn,
  heightMm: artworks.heightMm,
  widthMm: artworks.widthMm,
  depthMm: artworks.depthMm,
  orientation: artworks.orientation,
  sizeBucket: artworks.sizeBucket,
  priceUsdMinor: artworks.priceUsdMinor,
  isDemo: artworks.isDemo,
  ...commerceColumns,
  image: {
    id: artworkImages.id,
    role: artworkImages.role,
    publicKey: artworkImages.publicKey,
    width: artworkImages.width,
    height: artworkImages.height,
    altHe: artworkImages.altHe,
    altEn: artworkImages.altEn,
    blurDataUrl: artworkImages.blurDataUrl,
    dominantColor: artworkImages.dominantColor,
    creditLine: artworkImages.creditLine,
  },
};

/** A card row as Drizzle infers it (`image` is null when the work has no MAIN image). */
type CardRow = Awaited<ReturnType<typeof cardQuery>>[number];

interface ImageRow {
  id: string;
  role: ArtworkImageDTO["role"];
  publicKey: string;
  width: number;
  height: number;
  altHe: string;
  altEn: string;
  blurDataUrl: string | null;
  dominantColor: string | null;
  creditLine: string | null;
}

function imageDto(row: ImageRow, locale: Locale): ArtworkImageDTO {
  return {
    id: row.id,
    role: row.role,
    src: storage().publicUrl(row.publicKey),
    width: row.width,
    height: row.height,
    alt: locale === "he" ? row.altHe : row.altEn,
    blurDataUrl: row.blurDataUrl,
    dominantColor: row.dominantColor,
    creditLine: row.creditLine,
  };
}

function cardDto(r: CardRow, locale: Locale, now: Date): ArtworkCardDTO {
  const he = locale === "he";
  return {
    id: r.id,
    slug: r.slug,
    locale,
    title: he ? r.titleHe : r.titleEn,
    year: r.yearCreated,
    mediumText: (he ? r.mediumDetailHe : r.mediumDetailEn) ?? "",
    heightMm: r.heightMm,
    widthMm: r.widthMm,
    depthMm: r.depthMm,
    orientation: r.orientation,
    sizeBucket: r.sizeBucket,
    saleStatus: r.saleStatus,
    state: commerceStateOf(r, now),
    price: {
      ilsMinor: r.priceOnRequest ? null : r.priceIlsMinor,
      usdMinor: r.priceOnRequest ? null : r.priceUsdMinor,
      onRequest: r.priceOnRequest,
    },
    image: r.image ? imageDto(r.image, locale) : null,
    isDemo: r.isDemo,
  };
}

function cardQuery(db: DbOrTx) {
  return db
    .select(cardColumns)
    .from(artworks)
    .leftJoin(
      artworkImages,
      and(
        eq(artworkImages.artworkId, artworks.id),
        eq(artworkImages.role, "MAIN"),
      ),
    );
}

/** Available first, then on hold, then not for sale; featured first within a status. */
const statusRank = sql`CASE ${artworks.saleStatus} WHEN 'AVAILABLE' THEN 0 WHEN 'ON_HOLD' THEN 1 ELSE 2 END`;

export type WorksView = "current" | "sold";

/**
 * `/works`: the default view lists available, on-hold and not-for-sale works (available first);
 * `?availability=sold` is the archive, newest sale first.
 */
export async function listArtworks(
  locale: Locale,
  opts: { view?: WorksView; page?: number; pageSize?: number } = {},
  db: DbOrTx = defaultDb,
): Promise<CatalogPage<ArtworkCardDTO>> {
  const view = opts.view ?? "current";
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const where =
    view === "sold"
      ? and(eq(artworks.isPublished, true), eq(artworks.saleStatus, "SOLD"))
      : and(
          eq(artworks.isPublished, true),
          inArray(artworks.saleStatus, [
            "AVAILABLE",
            "ON_HOLD",
            "NOT_FOR_SALE",
          ]),
        );
  const order =
    view === "sold"
      ? [desc(artworks.soldAt), asc(artworks.sortOrder)]
      : [statusRank, desc(artworks.featured), asc(artworks.sortOrder)];
  const [rows, [total]] = await Promise.all([
    cardQuery(db)
      .where(where)
      .orderBy(...order, asc(artworks.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(artworks).where(where),
  ]);
  const now = new Date();
  return {
    items: rows.map((r) => cardDto(r, locale, now)),
    page,
    pageSize,
    total: total?.n ?? 0,
  };
}

/** The "Recently sold" strip (≤ 4). */
export async function listRecentlySold(
  locale: Locale,
  limit = 4,
  db: DbOrTx = defaultDb,
): Promise<ArtworkCardDTO[]> {
  const rows = await cardQuery(db)
    .where(
      and(
        eq(artworks.isPublished, true),
        eq(artworks.saleStatus, "SOLD"),
        isNotNull(artworks.soldAt),
      ),
    )
    .orderBy(desc(artworks.soldAt))
    .limit(limit);
  const now = new Date();
  return rows.map((r) => cardDto(r, locale, now));
}

/** Home hero: a featured available work, else the first available one. */
export async function getFeaturedArtwork(
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<ArtworkCardDTO | null> {
  const [row] = await cardQuery(db)
    .where(
      and(eq(artworks.isPublished, true), eq(artworks.saleStatus, "AVAILABLE")),
    )
    .orderBy(desc(artworks.featured), asc(artworks.sortOrder))
    .limit(1);
  return row ? cardDto(row, locale, new Date()) : null;
}

const detailColumns = {
  ...cardColumns,
  inventoryNumber: artworks.inventoryNumber,
  descriptionHe: artworks.descriptionHe,
  descriptionEn: artworks.descriptionEn,
  framed: artworks.framed,
  glazing: artworks.glazing,
  readyToHang: artworks.readyToHang,
  signed: artworks.signed,
  paintedEdges: artworks.paintedEdges,
  coaIncluded: artworks.coaIncluded,
  shipsInternationally: artworks.shipsInternationally,
  localPickupOnly: artworks.localPickupOnly,
  offersEnabled: artworks.offersEnabled,
  dispatchDays: artworks.dispatchDays,
  creditLine: artworks.creditLine,
  seriesSlug: series.slug,
  seriesNameHe: series.nameHe,
  seriesNameEn: series.nameEn,
};

export interface ArtworkPageData {
  artwork: ArtworkDetailDTO;
  /** Shipping engine input for the live buy box (server-only; never sent to the client). */
  shipSpec: ArtworkShipSpec;
}

/** `/works/[slug]`: a published work with its images, or null. */
export async function getArtworkPage(
  locale: Locale,
  slug: string,
  db: DbOrTx = defaultDb,
): Promise<ArtworkPageData | null> {
  const [row] = await db
    .select({
      ...detailColumns,
      ogKey: artworkImages.ogKey,
      packagingType: artworks.packagingType,
      canBeRolled: artworks.canBeRolled,
      packedLengthMm: artworks.packedLengthMm,
      packedWidthMm: artworks.packedWidthMm,
      packedHeightMm: artworks.packedHeightMm,
      packedWeightG: artworks.packedWeightG,
      sizeClassOverride: artworks.sizeClassOverride,
      maxInsurableValueMinor: artworks.maxInsurableValueMinor,
    })
    .from(artworks)
    .leftJoin(series, eq(series.id, artworks.seriesId))
    .leftJoin(
      artworkImages,
      and(
        eq(artworkImages.artworkId, artworks.id),
        eq(artworkImages.role, "MAIN"),
      ),
    )
    .where(and(eq(artworks.slug, slug), eq(artworks.isPublished, true)))
    .limit(1);
  if (!row) return null;

  const images = await db
    .select({
      id: artworkImages.id,
      role: artworkImages.role,
      publicKey: artworkImages.publicKey,
      width: artworkImages.width,
      height: artworkImages.height,
      altHe: artworkImages.altHe,
      altEn: artworkImages.altEn,
      blurDataUrl: artworkImages.blurDataUrl,
      dominantColor: artworkImages.dominantColor,
      creditLine: artworkImages.creditLine,
    })
    .from(artworkImages)
    .where(eq(artworkImages.artworkId, row.id))
    .orderBy(
      sql`CASE WHEN ${artworkImages.role} = 'MAIN' THEN 0 ELSE 1 END`,
      asc(artworkImages.sortOrder),
    );

  const he = locale === "he";
  const card = cardDto(row, locale, new Date());
  const artwork: ArtworkDetailDTO = {
    ...card,
    inventoryNumber: row.inventoryNumber,
    description: he ? row.descriptionHe : row.descriptionEn,
    series:
      row.seriesSlug && row.seriesNameHe && row.seriesNameEn
        ? {
            slug: row.seriesSlug,
            name: he ? row.seriesNameHe : row.seriesNameEn,
          }
        : null,
    images: images.map((i) => imageDto(i, locale)),
    framed: row.framed,
    glazing: row.glazing,
    readyToHang: row.readyToHang,
    signed: row.signed,
    paintedEdges: row.paintedEdges,
    coaIncluded: row.coaIncluded,
    shipsInternationally: row.shipsInternationally,
    localPickupOnly: row.localPickupOnly,
    quoteOnly: row.quoteOnly,
    offersEnabled: row.offersEnabled,
    dispatchDays: row.dispatchDays,
    creditLine: row.creditLine,
    ogImage: row.ogKey ? storage().publicUrl(row.ogKey) : null,
  };
  const shipSpec: ArtworkShipSpec = {
    artworkId: row.id,
    heightMm: row.heightMm,
    widthMm: row.widthMm,
    depthMm: row.depthMm,
    packagingType: row.packagingType,
    canBeRolled: row.canBeRolled,
    packedLengthMm: row.packedLengthMm ?? row.heightMm + 120,
    packedWidthMm: row.packedWidthMm ?? row.widthMm + 120,
    packedHeightMm: row.packedHeightMm ?? (row.depthMm ?? 30) + 80,
    packedWeightG: row.packedWeightG ?? 5000,
    sizeClassOverride: row.sizeClassOverride,
    glazing: row.glazing,
    framed: row.framed,
    shipsInternationally: row.shipsInternationally,
    localPickupOnly: row.localPickupOnly,
    quoteOnly: row.quoteOnly,
    maxInsurableValueMinor: row.maxInsurableValueMinor,
    dispatchDays: row.dispatchDays,
  };
  return { artwork, shipSpec };
}

export interface DeliveryEstimates {
  zones: ZoneEstimateDTO[];
  /** Studio pickup is offered at no charge. */
  pickupFree: boolean;
}

/** "Delivery from ₪X" per zone (spec §6.3), from the painter's table rates on `now`. */
export async function getDeliveryEstimates(
  locale: Locale,
  spec: ArtworkShipSpec,
  now: Date = new Date(),
  db: DbOrTx = defaultDb,
): Promise<DeliveryEstimates> {
  const settings = await getSetting("shipping", db);
  const estimates = zoneEstimates(spec, settings, now);
  const zones = settings.zones.map((z): ZoneEstimateDTO => {
    const e = estimates[z.id];
    const estimate = z.estimate[locale] || null;
    if (e === "QUOTE") return { zone: z.id, kind: "quote", estimate };
    if (e === "UNAVAILABLE" || e === undefined) {
      return { zone: z.id, kind: "unavailable", estimate };
    }
    return {
      zone: z.id,
      kind: "price",
      fromIlsMinor: e.fromIlsMinor,
      insured: e.insured,
      estimate,
    };
  });
  return {
    zones,
    pickupFree:
      settings.localPickup.enabled && settings.localPickup.feeIls === 0,
  };
}

/** `/credits`: every published demo work with its AIC caption. */
export async function listCredits(
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<CreditDTO[]> {
  const rows = await db
    .select({
      slug: artworks.slug,
      titleHe: artworks.titleHe,
      titleEn: artworks.titleEn,
      creditLine: artworks.creditLine,
    })
    .from(artworks)
    .where(
      and(
        eq(artworks.isDemo, true),
        eq(artworks.isPublished, true),
        isNotNull(artworks.creditLine),
      ),
    )
    .orderBy(asc(artworks.sortOrder));
  return rows.map((r) => ({
    slug: r.slug,
    title: locale === "he" ? r.titleHe : r.titleEn,
    caption: r.creditLine ?? "",
  }));
}
