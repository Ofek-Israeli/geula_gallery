import "server-only";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  type SQL,
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

/**
 * `current`: available, on-hold and not-for-sale works (available first); `available`: only works
 * whose sale status is AVAILABLE (including ones in another buyer's live checkout hold); `sold`:
 * the archive.
 */
export type WorksView = "current" | "available" | "sold";
export type WorksSort =
  | "featured"
  | "newest"
  | "price-asc"
  | "price-desc"
  | "size-asc"
  | "size-desc";

/** `/works` filters and sort (spec §6.2). Price bounds are ILS minor units, `[min, max)`. */
export interface ArtworkListQuery {
  view?: WorksView;
  page?: number;
  pageSize?: number;
  seriesSlug?: string | null;
  sizeBucket?: ArtworkCardDTO["sizeBucket"] | null;
  orientation?: ArtworkCardDTO["orientation"] | null;
  priceMinIlsMinor?: number | null;
  priceMaxIlsMinor?: number | null;
  sort?: WorksSort;
}

/** The visible ILS price (null when the price is on request). */
const visiblePrice = sql`CASE WHEN ${artworks.priceOnRequest} THEN NULL ELSE ${artworks.priceIlsMinor} END`;
const area = sql`(${artworks.heightMm}::bigint * ${artworks.widthMm})`;

function listWhere(q: ArtworkListQuery): SQL | undefined {
  const view = q.view ?? "current";
  const conds: (SQL | undefined)[] = [eq(artworks.isPublished, true)];
  if (view === "sold") conds.push(eq(artworks.saleStatus, "SOLD"));
  else if (view === "available")
    conds.push(eq(artworks.saleStatus, "AVAILABLE"));
  else
    conds.push(
      inArray(artworks.saleStatus, ["AVAILABLE", "ON_HOLD", "NOT_FOR_SALE"]),
    );
  if (q.seriesSlug) {
    conds.push(
      sql`${artworks.seriesId} = (SELECT s.id FROM series s WHERE s.slug = ${q.seriesSlug})`,
    );
  }
  if (q.sizeBucket) conds.push(eq(artworks.sizeBucket, q.sizeBucket));
  if (q.orientation) conds.push(eq(artworks.orientation, q.orientation));
  if (q.priceMinIlsMinor != null || q.priceMaxIlsMinor != null) {
    conds.push(
      eq(artworks.priceOnRequest, false),
      isNotNull(artworks.priceIlsMinor),
    );
    if (q.priceMinIlsMinor != null)
      conds.push(gte(artworks.priceIlsMinor, q.priceMinIlsMinor));
    if (q.priceMaxIlsMinor != null)
      conds.push(lt(artworks.priceIlsMinor, q.priceMaxIlsMinor));
  }
  return and(...conds);
}

function listOrder(q: ArtworkListQuery): SQL[] {
  const view = q.view ?? "current";
  const sort = q.sort ?? "featured";
  // Available works always come first in the current view (spec §1.2 "available works first").
  const rank = view === "current" ? [statusRank] : [];
  switch (sort) {
    case "newest":
      return [
        ...rank,
        sql`${artworks.yearCreated} DESC NULLS LAST`,
        sql`${artworks.publishedAt} DESC NULLS LAST`,
        asc(artworks.sortOrder),
      ];
    case "price-asc":
      return [...rank, sql`${visiblePrice} ASC NULLS LAST`];
    case "price-desc":
      return [...rank, sql`${visiblePrice} DESC NULLS LAST`];
    case "size-asc":
      return [...rank, sql`${area} ASC`];
    case "size-desc":
      return [...rank, sql`${area} DESC`];
    case "featured":
      return view === "sold"
        ? [sql`${artworks.soldAt} DESC NULLS LAST`, asc(artworks.sortOrder)]
        : [...rank, desc(artworks.featured), asc(artworks.sortOrder)];
  }
}

/**
 * `/works`: filtered, sorted and paginated (24 per page). The default view lists available, on-hold
 * and not-for-sale works (available first); `view: "sold"` is the archive, newest sale first.
 */
export async function listArtworks(
  locale: Locale,
  opts: ArtworkListQuery = {},
  db: DbOrTx = defaultDb,
): Promise<CatalogPage<ArtworkCardDTO>> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const where = listWhere(opts);
  const [rows, [total]] = await Promise.all([
    cardQuery(db)
      .where(where)
      .orderBy(...listOrder(opts), asc(artworks.id))
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

export interface SeriesSummary {
  slug: string;
  name: string;
  /** Published works in the current view (available, on hold, not for sale). */
  count: number;
  /** MAIN image of the series' first work (available and featured first). */
  cover: ArtworkImageDTO | null;
}

/** Series with at least one published, unsold work (filters and the home page). */
export async function listSeries(
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<SeriesSummary[]> {
  const current = and(
    eq(artworks.isPublished, true),
    inArray(artworks.saleStatus, ["AVAILABLE", "ON_HOLD", "NOT_FOR_SALE"]),
  );
  const [counts, covers] = await Promise.all([
    db
      .select({
        id: series.id,
        slug: series.slug,
        nameHe: series.nameHe,
        nameEn: series.nameEn,
        n: count(artworks.id),
      })
      .from(series)
      .innerJoin(artworks, and(eq(artworks.seriesId, series.id), current))
      .groupBy(series.id)
      .orderBy(asc(series.sortOrder), asc(series.slug)),
    db
      .selectDistinctOn([artworks.seriesId], {
        seriesId: artworks.seriesId,
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
      })
      .from(artworks)
      .innerJoin(
        artworkImages,
        and(
          eq(artworkImages.artworkId, artworks.id),
          eq(artworkImages.role, "MAIN"),
        ),
      )
      .where(and(current, isNotNull(artworks.seriesId)))
      .orderBy(
        artworks.seriesId,
        statusRank,
        desc(artworks.featured),
        asc(artworks.sortOrder),
      ),
  ]);
  const coverOf = new Map(covers.map((c) => [c.seriesId, c.image]));
  return counts.map((s) => {
    const img = coverOf.get(s.id);
    return {
      slug: s.slug,
      name: locale === "he" ? s.nameHe : s.nameEn,
      count: s.n,
      cover: img ? imageDto(img, locale) : null,
    };
  });
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
  /** Structured-data and metadata extras (JSON-LD `artMedium` / `artworkSurface`, dates). */
  seo: ArtworkSeo;
}

export interface ArtworkSeo {
  medium: (typeof artworks.$inferSelect)["medium"];
  surface: (typeof artworks.$inferSelect)["surface"];
  publishedAt: string | null;
  updatedAt: string;
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
      mainPublicKey: artworkImages.publicKey,
      medium: artworks.medium,
      surface: artworks.surface,
      publishedAt: artworks.publishedAt,
      updatedAt: artworks.updatedAt,
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
    // A DETAIL promoted to MAIN has no OG rendition (only uploads create one): fall back to the
    // MAIN image itself (the page then declares that image's own size).
    ogImage: row.ogKey
      ? storage().publicUrl(row.ogKey)
      : row.mainPublicKey
        ? storage().publicUrl(row.mainPublicKey)
        : null,
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
  const seo: ArtworkSeo = {
    medium: row.medium,
    surface: row.surface,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
  return { artwork, shipSpec, seo };
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

/**
 * The OG image of a published work: the MAIN image's 1200×630 `og_key` rendition, else the MAIN
 * image itself (a DETAIL promoted to MAIN has no rendition), with its size; or null.
 */
export async function getArtworkOgImage(
  slug: string,
  db: DbOrTx = defaultDb,
): Promise<{ url: string; width: number; height: number } | null> {
  const [row] = await db
    .select({
      ogKey: artworkImages.ogKey,
      publicKey: artworkImages.publicKey,
      width: artworkImages.width,
      height: artworkImages.height,
    })
    .from(artworks)
    .innerJoin(
      artworkImages,
      and(
        eq(artworkImages.artworkId, artworks.id),
        eq(artworkImages.role, "MAIN"),
      ),
    )
    .where(and(eq(artworks.slug, slug), eq(artworks.isPublished, true)))
    .limit(1);
  if (!row) return null;
  // The 1200×630 OG rendition, or the MAIN image itself when it has none (a promoted DETAIL).
  return row.ogKey
    ? { url: storage().publicUrl(row.ogKey), width: 1200, height: 630 }
    : {
        url: storage().publicUrl(row.publicKey),
        width: row.width,
        height: row.height,
      };
}

export interface SitemapArtwork {
  slug: string;
  lastModified: Date;
  /** Public image URLs (relative to the site unless the storage driver returns absolute URLs). */
  images: string[];
}

/** Every published work (any sale status) for `sitemap.ts`, with its image URLs. */
export async function listSitemapArtworks(
  db: DbOrTx = defaultDb,
): Promise<SitemapArtwork[]> {
  const rows = await db
    .select({
      id: artworks.id,
      slug: artworks.slug,
      updatedAt: artworks.updatedAt,
      publicKey: artworkImages.publicKey,
    })
    .from(artworks)
    .leftJoin(artworkImages, eq(artworkImages.artworkId, artworks.id))
    .where(eq(artworks.isPublished, true))
    .orderBy(
      asc(artworks.sortOrder),
      asc(artworks.id),
      sql`CASE WHEN ${artworkImages.role} = 'MAIN' THEN 0 ELSE 1 END`,
      asc(artworkImages.sortOrder),
    );
  const out = new Map<string, SitemapArtwork>();
  for (const r of rows) {
    let entry = out.get(r.id);
    if (!entry) {
      entry = { slug: r.slug, lastModified: r.updatedAt, images: [] };
      out.set(r.id, entry);
    }
    if (r.publicKey) entry.images.push(storage().publicUrl(r.publicKey));
  }
  return [...out.values()];
}

/**
 * The public face of the business profile (about, contact, JSON-LD). Never includes the ID
 * number, the legal name or addresses (spec §1.2 "Seller identity", §4.7).
 */
export interface PublicProfile {
  tradeName: string;
  artistName: string;
  email: string;
  phoneIntl: string;
  phoneLocal: string;
}

export async function getPublicProfile(
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<PublicProfile> {
  const p = await getSetting("business_profile", db);
  return {
    tradeName: p.tradeName[locale],
    artistName: p.artistName[locale],
    email: p.email,
    phoneIntl: p.phoneIntl,
    phoneLocal: p.phoneLocal,
  };
}
