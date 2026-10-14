import "server-only";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  type SQL,
  sql,
} from "drizzle-orm";
import type {
  ArtworkCardDTO,
  ArtworkDetailDTO,
  ArtworkImageDTO,
  CatalogPage,
  ZoneEstimateDTO,
} from "@/lib/catalog";
import type { Locale } from "@/lib/locale";
import { type ActiveSale, activeSale, applySale } from "@/lib/sale";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworkImages, artworks, series } from "@/server/db/schema";
import { env } from "@/server/env";
import { getSetting, getSettingOrNull } from "@/server/settings";
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

/** The site-wide sale running now (`checkout.sale`), or null. */
async function runningSale(db: DbOrTx): Promise<ActiveSale | null> {
  return activeSale((await getSettingOrNull("checkout", db))?.sale);
}

function cardDto(
  r: CardRow,
  locale: Locale,
  now: Date,
  sale: ActiveSale | null,
): ArtworkCardDTO {
  const he = locale === "he";
  const onSale = sale !== null && !r.priceOnRequest;
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
    // The preview (CHECKOUT_PREVIEW) shows Buy now and the cart too; no real payment is taken.
    state: commerceStateOf(r, now, env.salesAccess !== "closed"),
    price: {
      ilsMinor: r.priceOnRequest
        ? null
        : applySale(r.priceIlsMinor, sale, r.id),
      usdMinor: r.priceOnRequest
        ? null
        : applySale(r.priceUsdMinor, sale, r.id),
      onRequest: r.priceOnRequest,
      wasIlsMinor: onSale ? r.priceIlsMinor : null,
      wasUsdMinor: onSale ? r.priceUsdMinor : null,
      saleEndsOn: onSale ? sale.endsOn : null,
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

/** Available first, then on hold, not for sale and sold; featured first within a status. */
const statusRank = sql`CASE ${artworks.saleStatus} WHEN 'AVAILABLE' THEN 0 WHEN 'ON_HOLD' THEN 1 WHEN 'NOT_FOR_SALE' THEN 2 ELSE 3 END`;

/**
 * `current`: every published work, sold ones included and labelled "Sold" where they appear
 * (available first); `available`: only works whose sale status is AVAILABLE (including ones in
 * another buyer's live checkout hold). There is no sold-only view: visitors cannot browse for
 * sold works, they simply meet them, labelled, in the lists they belong to.
 */
export type WorksView = "current" | "available";
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

/**
 * The shown ILS price in SQL: the list price, less the running sale (each work's own percentage),
 * rounded to whole shekels like `salePriceMinor`.
 */
function shownPriceSql(sale: ActiveSale | null): SQL {
  if (!sale) return sql`${artworks.priceIlsMinor}`;
  const own = Object.entries(sale.perWork);
  const pct =
    own.length === 0
      ? sql`${sale.percentOff}::int`
      : sql`CASE ${artworks.id} ${sql.join(
          own.map(([id, p]) => sql`WHEN ${id}::uuid THEN ${p}::int`),
          sql` `,
        )} ELSE ${sale.percentOff}::int END`;
  return sql`GREATEST(100, ROUND(${artworks.priceIlsMinor} * (100 - ${pct}) / 10000.0) * 100)`;
}

/** The visible ILS price (null when the price is on request). */
function visiblePrice(sale: ActiveSale | null): SQL {
  return sql`CASE WHEN ${artworks.priceOnRequest} THEN NULL ELSE ${shownPriceSql(sale)} END`;
}
const area = sql`(${artworks.heightMm}::bigint * ${artworks.widthMm})`;

function listWhere(
  q: ArtworkListQuery,
  sale: ActiveSale | null = null,
): SQL | undefined {
  const view = q.view ?? "current";
  const conds: (SQL | undefined)[] = [eq(artworks.isPublished, true)];
  if (view === "available") conds.push(eq(artworks.saleStatus, "AVAILABLE"));
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
    // The bands filter the shown (sale) price.
    if (q.priceMinIlsMinor != null)
      conds.push(sql`${shownPriceSql(sale)} >= ${q.priceMinIlsMinor}`);
    if (q.priceMaxIlsMinor != null)
      conds.push(sql`${shownPriceSql(sale)} < ${q.priceMaxIlsMinor}`);
  }
  return and(...conds);
}

function listOrder(q: ArtworkListQuery, sale: ActiveSale | null): SQL[] {
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
      return [...rank, sql`${visiblePrice(sale)} ASC NULLS LAST`];
    case "price-desc":
      return [...rank, sql`${visiblePrice(sale)} DESC NULLS LAST`];
    case "size-asc":
      return [...rank, sql`${area} ASC`];
    case "size-desc":
      return [...rank, sql`${area} DESC`];
    case "featured":
      return [...rank, desc(artworks.featured), asc(artworks.sortOrder)];
  }
}

/**
 * `/works`: filtered, sorted and paginated (24 per page). The default view lists every published
 * work, available first and sold last (labelled "Sold").
 */
export async function listArtworks(
  locale: Locale,
  opts: ArtworkListQuery = {},
  db: DbOrTx = defaultDb,
): Promise<CatalogPage<ArtworkCardDTO>> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const sale = await runningSale(db);
  const where = listWhere(opts, sale);
  const [rows, [total]] = await Promise.all([
    cardQuery(db)
      .where(where)
      .orderBy(...listOrder(opts, sale), asc(artworks.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(artworks).where(where),
  ]);
  const now = new Date();
  return {
    items: rows.map((r) => cardDto(r, locale, now, sale)),
    page,
    pageSize,
    total: total?.n ?? 0,
  };
}

export interface SeriesSummary {
  slug: string;
  name: string;
  /** Published works in the series (sold ones included). */
  count: number;
  /** MAIN image of the series' first work (available and featured first). */
  cover: ArtworkImageDTO | null;
}

/** Series with at least one published work (filters and the home page). */
export async function listSeries(
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<SeriesSummary[]> {
  const current = eq(artworks.isPublished, true);
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
  return row ? cardDto(row, locale, new Date(), await runningSale(db)) : null;
}

/** The painting behind the home page's quote and the site footer. */
export const HERO_ARTWORK_SLUG = "by-the-lake";

/** The hero painting, else the featured available work (a catalog without it still opens). */
export async function getHeroArtwork(
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<ArtworkCardDTO | null> {
  return (
    (await getArtworkCard(locale, HERO_ARTWORK_SLUG, db)) ??
    (await getFeaturedArtwork(locale, db))
  );
}

/** One published work as a card, whatever its sale status (the home hero names a fixed work). */
export async function getArtworkCard(
  locale: Locale,
  slug: string,
  db: DbOrTx = defaultDb,
): Promise<ArtworkCardDTO | null> {
  const [row] = await cardQuery(db)
    .where(and(eq(artworks.isPublished, true), eq(artworks.slug, slug)))
    .limit(1);
  return row ? cardDto(row, locale, new Date(), await runningSale(db)) : null;
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

/** A cart line's work: the card plus what the pre-contract disclosure needs. */
export interface CartWorkDTO extends ArtworkCardDTO {
  inventoryNumber: string;
  framed: boolean;
  signed: boolean;
  coaIncluded: boolean;
}

/**
 * The published works among `ids`, in `ids` order (the cart page and the cart checkout). Unknown or
 * unpublished ids are left out; live state is read per request like every catalog read.
 */
export async function getCartWorks(
  locale: Locale,
  ids: readonly string[],
  db: DbOrTx = defaultDb,
): Promise<CartWorkDTO[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      ...cardColumns,
      inventoryNumber: artworks.inventoryNumber,
      framed: artworks.framed,
      signed: artworks.signed,
      coaIncluded: artworks.coaIncluded,
    })
    .from(artworks)
    .leftJoin(
      artworkImages,
      and(
        eq(artworkImages.artworkId, artworks.id),
        eq(artworkImages.role, "MAIN"),
      ),
    )
    .where(and(inArray(artworks.id, [...ids]), eq(artworks.isPublished, true)));
  const now = new Date();
  const sale = await runningSale(db);
  const byId = new Map(
    rows.map((r) => [
      r.id,
      {
        ...cardDto(r, locale, now, sale),
        inventoryNumber: r.inventoryNumber,
        framed: r.framed,
        signed: r.signed,
        coaIncluded: r.coaIncluded,
      } satisfies CartWorkDTO,
    ]),
  );
  return ids.flatMap((id) => {
    const w = byId.get(id);
    return w ? [w] : [];
  });
}

/** How many of `ids` are published and not sold (the header cart count). */
export async function countCartWorks(
  ids: readonly string[],
  db: DbOrTx = defaultDb,
): Promise<number> {
  if (ids.length === 0) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(artworks)
    .where(
      and(
        inArray(artworks.id, [...ids]),
        eq(artworks.isPublished, true),
        sql`${artworks.saleStatus} <> 'SOLD'`,
      ),
    );
  return Number(row?.n ?? 0);
}

export interface ArtworkPageData {
  artwork: ArtworkDetailDTO;
  /** Shipping engine input for the live buy box (server-only; never sent to the client). */
  shipSpec: ArtworkShipSpec;
  /** Customs value in ILS minor units (override, else the price; server-only), for estimates. */
  declaredValueIlsMinor: number;
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
      declaredValueOverrideMinor: artworks.declaredValueOverrideMinor,
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
  const sale = await runningSale(db);
  const card = cardDto(row, locale, new Date(), sale);
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
  return {
    artwork,
    shipSpec,
    seo,
    // The price actually paid: the sale price while a sale runs.
    declaredValueIlsMinor:
      row.declaredValueOverrideMinor ??
      applySale(row.priceIlsMinor, sale, row.id) ??
      0,
  };
}

export interface DeliveryEstimates {
  zones: ZoneEstimateDTO[];
  /** Studio pickup is offered at no charge. */
  pickupFree: boolean;
}

/**
 * "Delivery from ₪X" per zone (spec §6.3) on `now`: the table in Israel, the cheapest DHL estimate
 * abroad (`zoneEstimates`). With the work's customs value, the estimate includes the export
 * declaration when it is due.
 */
export async function getDeliveryEstimates(
  locale: Locale,
  spec: ArtworkShipSpec,
  now: Date = new Date(),
  db: DbOrTx = defaultDb,
  declaredValueIlsMinor?: number,
): Promise<DeliveryEstimates> {
  const settings = await getSetting("shipping", db);
  const value =
    declaredValueIlsMinor === undefined
      ? undefined
      : {
          declaredValueIlsMinor,
          fx: (await getSetting("checkout", db)).fx,
        };
  const estimates = zoneEstimates(spec, settings, now, value);
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
      rolled: e.rolled === true,
      // The time of the option that gives the price (Israel Post's own), else the zone's.
      estimate: e.estimate?.[locale] || estimate,
    };
  });
  return {
    zones,
    pickupFree:
      settings.localPickup.enabled && settings.localPickup.feeIls === 0,
  };
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
 * number or the legal name (spec §1.2 "Seller identity", §4.7). The business address is public:
 * it is on the terms page, and Isracard's online-acceptance form requires a contact area with the
 * full address, country and phone.
 */
export interface PublicProfile {
  tradeName: string;
  artistName: string;
  email: string;
  phoneIntl: string;
  phoneLocal: string;
  /** The business address in the page's locale (the country is added by the page). */
  address: string;
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
    address: p.address[locale],
  };
}
