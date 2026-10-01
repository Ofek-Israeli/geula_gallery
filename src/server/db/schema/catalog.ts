import "server-only";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  pgSequence,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { SLUG_REGEX, timestamps, tstz } from "./columns";
import { orders } from "./commerce";
import {
  artworkSaleStatusEnum,
  glazingEnum,
  holdReasonEnum,
  imageRoleEnum,
  mediumEnum,
  orientationEnum,
  packagingTypeEnum,
  sizeBucketEnum,
  sizeClassEnum,
  surfaceEnum,
} from "./enums";

/** Feeds `artworks.inventory_number` (`A-YYYY-NNN`). */
export const artworkInventorySeq = pgSequence("artwork_inventory_seq", {
  startWith: 1,
  increment: 1,
});

export const series = pgTable(
  "series",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    nameHe: text().notNull(),
    nameEn: text().notNull(),
    sortOrder: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    check("series_slug_format", sql`${t.slug} ~ ${sql.raw(`'${SLUG_REGEX}'`)}`),
  ],
);

export const artworks = pgTable(
  "artworks",
  {
    // Identity
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    inventoryNumber: text()
      .notNull()
      .unique("artworks_inventory_number_unique")
      .default(
        sql`('A-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('artwork_inventory_seq')::text, 3, '0'))`,
      ),
    isDemo: boolean().notNull().default(false),
    seriesId: uuid().references(() => series.id, { onDelete: "set null" }),

    // Text
    titleHe: text().notNull(),
    titleEn: text().notNull(),
    descriptionHe: text().notNull().default(""),
    descriptionEn: text().notNull().default(""),
    yearCreated: smallint(),
    medium: mediumEnum().notNull(),
    surface: surfaceEnum().notNull(),
    mediumDetailHe: text(),
    mediumDetailEn: text(),

    // Physical (integer mm)
    heightMm: integer().notNull(),
    widthMm: integer().notNull(),
    depthMm: integer(),
    framed: boolean().notNull().default(false),
    frameHeightMm: integer(),
    frameWidthMm: integer(),
    frameDepthMm: integer(),
    glazing: glazingEnum().notNull().default("NONE"),
    readyToHang: boolean().notNull().default(false),
    signed: boolean().notNull().default(false),
    paintedEdges: boolean().notNull().default(false),
    coaIncluded: boolean().notNull().default(false),
    orientation: orientationEnum().notNull(),
    /** Derived from the dimensions by the app (`src/lib/dimensions.ts`). */
    sizeBucket: sizeBucketEnum().notNull(),

    // Publication
    isPublished: boolean().notNull().default(false),
    publishedAt: tstz(),
    featured: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),

    // Sale state (reservation columns are not a status; spec §3.6)
    saleStatus: artworkSaleStatusEnum().notNull().default("AVAILABLE"),
    holdReason: holdReasonEnum(),
    holdNote: text(),
    reservedByOrderId: uuid().references((): AnyPgColumn => orders.id, {
      onDelete: "restrict",
    }),
    reservedUntil: tstz(),
    soldAt: tstz(),

    // Pricing (integer minor units). price_ils_minor is the consumer total (incl. VAT if murshe).
    priceIlsMinor: integer(),
    priceUsdMinor: integer(),
    priceOnRequest: boolean().notNull().default(false),
    priceChangedAt: tstz(),
    offersEnabled: boolean().notNull().default(false),
    offerAutoDeclineBelowIlsMinor: integer(),

    // Shipping
    packagingType: packagingTypeEnum().notNull().default("STRETCHED_BOX"),
    canBeRolled: boolean().notNull().default(false),
    packedLengthMm: integer(),
    packedWidthMm: integer(),
    packedHeightMm: integer(),
    packedWeightG: integer(),
    sizeClassOverride: sizeClassEnum(),
    shipsInternationally: boolean().notNull().default(true),
    localPickupOnly: boolean().notNull().default(false),
    quoteOnly: boolean().notNull().default(false),
    dispatchDays: smallint().notNull().default(5),

    // Customs
    hsCode: text().notNull().default("9701.91"),
    customsDescriptionEn: text(),
    countryOfOrigin: char({ length: 2 }).notNull().default("IL"),
    declaredValueOverrideMinor: integer(),
    maxInsurableValueMinor: integer(),
    creditLine: text(),

    ...timestamps,
  },
  (t) => [
    check(
      "artworks_slug_format",
      sql`${t.slug} ~ ${sql.raw(`'${SLUG_REGEX}'`)}`,
    ),
    check(
      "artworks_year_created_range",
      sql`${t.yearCreated} IS NULL OR ${t.yearCreated} BETWEEN 1800 AND 2100`,
    ),
    check(
      "artworks_dimensions_positive",
      sql`${t.heightMm} > 0 AND ${t.widthMm} > 0 AND (${t.depthMm} IS NULL OR ${t.depthMm} >= 0)`,
    ),
    check(
      "artworks_packed_positive",
      sql`(${t.packedLengthMm} IS NULL OR ${t.packedLengthMm} > 0) AND (${t.packedWidthMm} IS NULL OR ${t.packedWidthMm} > 0) AND (${t.packedHeightMm} IS NULL OR ${t.packedHeightMm} > 0) AND (${t.packedWeightG} IS NULL OR ${t.packedWeightG} > 0)`,
    ),
    check(
      "artworks_reservation_pair",
      sql`(${t.reservedByOrderId} IS NULL) = (${t.reservedUntil} IS NULL)`,
    ),
    check(
      "artworks_reserved_only_available",
      sql`${t.reservedByOrderId} IS NULL OR ${t.saleStatus} = 'AVAILABLE'`,
    ),
    check(
      "artworks_sold_has_sold_at",
      sql`${t.saleStatus} <> 'SOLD' OR ${t.soldAt} IS NOT NULL`,
    ),
    check(
      "artworks_prices_positive",
      sql`(${t.priceIlsMinor} IS NULL OR ${t.priceIlsMinor} > 0) AND (${t.priceUsdMinor} IS NULL OR ${t.priceUsdMinor} > 0) AND (${t.offerAutoDeclineBelowIlsMinor} IS NULL OR ${t.offerAutoDeclineBelowIlsMinor} > 0)`,
    ),
    check(
      "artworks_customs_values_positive",
      sql`(${t.declaredValueOverrideMinor} IS NULL OR ${t.declaredValueOverrideMinor} > 0) AND (${t.maxInsurableValueMinor} IS NULL OR ${t.maxInsurableValueMinor} >= 0)`,
    ),
    check("artworks_dispatch_days", sql`${t.dispatchDays} >= 0`),
    index("artworks_listing_idx").on(t.isPublished, t.saleStatus, t.sortOrder),
    index("artworks_series_idx").on(t.seriesId),
    index("artworks_reserved_until_idx")
      .on(t.reservedUntil)
      .where(sql`${t.reservedByOrderId} IS NOT NULL`),
  ],
);

export const artworkImages = pgTable(
  "artwork_images",
  {
    id: uuid().primaryKey().defaultRandom(),
    artworkId: uuid()
      .notNull()
      .references(() => artworks.id, { onDelete: "cascade" }),
    role: imageRoleEnum().notNull(),
    sortOrder: integer().notNull().default(0),
    /** Required before publishing (publish checklist); empty until the editor fills it. */
    altHe: text().notNull().default(""),
    altEn: text().notNull().default(""),
    publicKey: text().notNull(),
    /** Private store key of the untouched original. */
    originalKey: text(),
    ogKey: text(),
    width: integer().notNull(),
    height: integer().notNull(),
    bytes: integer().notNull(),
    contentHash: text().notNull(),
    blurDataUrl: text(),
    dominantColor: text(),
    creditLine: text(),
    ...timestamps,
  },
  (t) => [
    check(
      "artwork_images_dominant_color_hex",
      sql`${t.dominantColor} IS NULL OR ${t.dominantColor} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
    check(
      "artwork_images_size_positive",
      sql`${t.width} > 0 AND ${t.height} > 0 AND ${t.bytes} > 0`,
    ),
    uniqueIndex("artwork_images_one_main_idx")
      .on(t.artworkId)
      .where(sql`${t.role} = 'MAIN'`),
    index("artwork_images_artwork_sort_idx").on(t.artworkId, t.sortOrder),
  ],
);

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;
export type Artwork = typeof artworks.$inferSelect;
export type NewArtwork = typeof artworks.$inferInsert;
export type ArtworkImage = typeof artworkImages.$inferSelect;
export type NewArtworkImage = typeof artworkImages.$inferInsert;
