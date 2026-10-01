import "server-only";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { orientationOf, sizeBucketOf } from "@/lib/dimensions";
import type { Currency } from "@/lib/money";
import { slugify } from "@/lib/validation/identifiers";
import { audit, auditBy } from "@/server/audit";
import {
  lockArtworks,
  lockOrder,
  orderArtworkIds,
  ordersWithAttemptInFlight,
  releaseHoldsOf,
} from "@/server/checkout/reservations";
import { type Db, db as defaultDb, type Tx } from "@/server/db/client";
import {
  type Artwork,
  artworkImages,
  artworks,
  cancellations,
  orderItems,
  refunds,
  sales,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
} from "@/server/domain/errors";
import { transition } from "@/server/domain/transition";
import { log } from "@/server/log";
import type { PackagingType } from "@/server/shipping/types";
import {
  storage as defaultStorage,
  type StorageAdapter,
} from "@/server/storage";

/**
 * Admin catalog mutations (spec §5.9, §6.10 artwork editor, §3.6 artwork machine). Every function
 * takes the `AdminContext`, runs in one `withTx`, **locks the artwork first** (global lock order:
 * artworks → orders → attempts → refunds), uses conditional updates (`transition()` for the sale
 * status) and writes an audit row in the same transaction.
 *
 * Offline hold / sale / not-for-sale over a **live checkout hold** need `confirmOverride`: the
 * holding order is expired (`ADMIN`) and its holds cleared first. They are refused while that
 * order has an attempt in CAPTURING or PAYMENT_REVIEW (a payment is being confirmed).
 */
export interface CatalogDeps {
  db?: Db;
  storage?: StorageAdapter;
}

const MEDIUMS = [
  "OIL",
  "ACRYLIC",
  "WATERCOLOR",
  "GOUACHE",
  "INK",
  "CHARCOAL",
  "PASTEL",
  "TEMPERA",
  "MIXED_MEDIA",
  "OTHER",
] as const;
const SURFACES = [
  "CANVAS",
  "LINEN",
  "WOOD_PANEL",
  "BOARD",
  "CARDBOARD",
  "PAPER",
  "OTHER",
] as const;
export const ARTWORK_MEDIUMS = MEDIUMS;
export const ARTWORK_SURFACES = SURFACES;
export type Medium = (typeof MEDIUMS)[number];
export type Surface = (typeof SURFACES)[number];
export const HOLD_REASONS = [
  "EXHIBITION",
  "CONSIGNMENT",
  "PRIVATE_VIEWING",
  "RESERVED_OFFLINE",
  "OTHER",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
export const PACKAGING_TYPES = [
  "ROLLED_TUBE",
  "FLAT_BOX",
  "STRETCHED_BOX",
  "FRAMED_BOX",
  "CRATE",
] as const satisfies readonly PackagingType[];
export const IMAGE_ROLES = [
  "MAIN",
  "DETAIL",
  "EDGE",
  "BACK",
  "FRAMED",
  "IN_ROOM",
  "PROCESS",
] as const;
export type ImageRoleValue = (typeof IMAGE_ROLES)[number];

// ---------------------------------------------------------------- helpers

async function lockOne(tx: Tx, id: string): Promise<Artwork> {
  const [a] = await lockArtworks(tx, [id]);
  if (!a) throw new NotFoundError("artwork", id);
  return a;
}

function changed<T extends Record<string, unknown>>(
  before: Record<string, unknown>,
  after: T,
): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    const prev = before[key as string];
    const next = after[key];
    const same =
      prev instanceof Date && next instanceof Date
        ? prev.getTime() === next.getTime()
        : prev === next;
    if (!same) {
      b[key] = prev as T[keyof T];
      a[key] = next;
    }
  }
  return { before: b, after: a };
}

async function updateColumns(
  tx: Tx,
  ctx: AdminContext,
  a: Artwork,
  patch: Partial<typeof artworks.$inferInsert>,
  action: string,
): Promise<boolean> {
  const diff = changed(a as unknown as Record<string, unknown>, patch);
  if (Object.keys(diff.after).length === 0) return false;
  try {
    await tx
      .update(artworks)
      .set({ ...diff.after, updatedAt: new Date() })
      .where(eq(artworks.id, a.id));
  } catch (error) {
    if (isUniqueViolation(error, "artworks_slug_unique")) {
      throw new ConflictError("SLUG_TAKEN", "the slug is used by another work");
    }
    throw error;
  }
  await audit(
    {
      ...auditBy(ctx),
      action,
      entity: "artwork",
      entityId: a.id,
      before: diff.before,
      after: diff.after,
    },
    tx,
  );
  return true;
}

// ---------------------------------------------------------------- create and edit

export interface CreateArtworkInput {
  titleHe: string;
  titleEn: string;
  slug?: string;
  medium: Medium;
  surface: Surface;
  heightMm: number;
  widthMm: number;
  depthMm?: number | null;
}

export async function createArtwork(
  ctx: AdminContext,
  input: CreateArtworkInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ id: string; slug: string }>> {
  const slug = (input.slug?.trim() || slugify(input.titleEn)).slice(0, 120);
  if (!slug) {
    throw new ConflictError("SLUG_REQUIRED", "a Latin slug is required");
  }
  const db = deps.db ?? defaultDb;
  try {
    const row = await withTx(
      async (tx) => {
        const [inserted] = await tx
          .insert(artworks)
          .values({
            slug,
            titleHe: input.titleHe.trim(),
            titleEn: input.titleEn.trim(),
            medium: input.medium,
            surface: input.surface,
            heightMm: input.heightMm,
            widthMm: input.widthMm,
            depthMm: input.depthMm ?? null,
            orientation: orientationOf(input.heightMm, input.widthMm),
            sizeBucket: sizeBucketOf(input.heightMm, input.widthMm),
            packagingType: suggestedPackagingType(input),
          })
          .returning({ id: artworks.id, slug: artworks.slug });
        if (!inserted) throw new Error("artwork insert returned no row");
        await audit(
          {
            ...auditBy(ctx),
            action: "artwork.created",
            entity: "artwork",
            entityId: inserted.id,
            after: { slug, titleEn: input.titleEn },
          },
          tx,
        );
        return inserted;
      },
      { db, name: "catalog.create" },
    );
    return withEffects(row);
  } catch (error) {
    if (isUniqueViolation(error, "artworks_slug_unique")) {
      throw new ConflictError("SLUG_TAKEN", "the slug is used by another work");
    }
    throw error;
  }
}

export interface ArtworkDetailsInput {
  titleHe: string;
  titleEn: string;
  slug: string;
  descriptionHe: string;
  descriptionEn: string;
  yearCreated: number | null;
  medium: Medium;
  surface: Surface;
  mediumDetailHe: string | null;
  mediumDetailEn: string | null;
  seriesId: string | null;
  featured: boolean;
  sortOrder: number;
}

export async function updateArtworkDetails(
  ctx: AdminContext,
  id: string,
  input: ArtworkDetailsInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ changed: boolean }>> {
  const did = await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      if (a.publishedAt !== null && input.slug !== a.slug) {
        throw new ConflictError(
          "SLUG_LOCKED",
          "the slug cannot change after the first publish",
        );
      }
      return updateColumns(
        tx,
        ctx,
        a,
        {
          titleHe: input.titleHe.trim(),
          titleEn: input.titleEn.trim(),
          slug: input.slug,
          descriptionHe: input.descriptionHe,
          descriptionEn: input.descriptionEn,
          yearCreated: input.yearCreated,
          medium: input.medium,
          surface: input.surface,
          mediumDetailHe: input.mediumDetailHe,
          mediumDetailEn: input.mediumDetailEn,
          seriesId: input.seriesId,
          featured: input.featured,
          sortOrder: input.sortOrder,
        },
        "artwork.details_updated",
      );
    },
    { db: deps.db, name: "catalog.details" },
  );
  return withEffects({ changed: did }, did ? { revalidate: true } : {});
}

export interface ArtworkSizeInput {
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
  framed: boolean;
  frameHeightMm: number | null;
  frameWidthMm: number | null;
  frameDepthMm: number | null;
  glazing: "NONE" | "GLASS" | "ACRYLIC";
  readyToHang: boolean;
  signed: boolean;
  paintedEdges: boolean;
  coaIncluded: boolean;
}

export async function updateArtworkSize(
  ctx: AdminContext,
  id: string,
  input: ArtworkSizeInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ changed: boolean }>> {
  const did = await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      return updateColumns(
        tx,
        ctx,
        a,
        {
          ...input,
          frameHeightMm: input.framed ? input.frameHeightMm : null,
          frameWidthMm: input.framed ? input.frameWidthMm : null,
          frameDepthMm: input.framed ? input.frameDepthMm : null,
          orientation: orientationOf(input.heightMm, input.widthMm),
          sizeBucket: sizeBucketOf(input.heightMm, input.widthMm),
        },
        "artwork.size_updated",
      );
    },
    { db: deps.db, name: "catalog.size" },
  );
  return withEffects({ changed: did }, did ? { revalidate: true } : {});
}

export interface ArtworkPriceInput {
  priceIlsMinor: number | null;
  priceUsdMinor: number | null;
  priceOnRequest: boolean;
  offersEnabled: boolean;
  offerAutoDeclineBelowIlsMinor: number | null;
  /** Required when an existing ILS or USD price changes (spec §10.4 `admin-artwork`). */
  confirmPriceChange: boolean;
}

export async function updateArtworkPrice(
  ctx: AdminContext,
  id: string,
  input: ArtworkPriceInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ changed: boolean; priceChanged: boolean }>> {
  const out = await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      const priceChanged =
        (a.priceIlsMinor !== null && a.priceIlsMinor !== input.priceIlsMinor) ||
        (a.priceUsdMinor !== null && a.priceUsdMinor !== input.priceUsdMinor);
      if (priceChanged && !input.confirmPriceChange) {
        throw new ConflictError(
          "PRICE_CONFIRM_REQUIRED",
          "confirm the price change",
          {
            beforeIlsMinor: a.priceIlsMinor,
            afterIlsMinor: input.priceIlsMinor,
            beforeUsdMinor: a.priceUsdMinor,
            afterUsdMinor: input.priceUsdMinor,
          },
        );
      }
      const anyPriceMoved =
        a.priceIlsMinor !== input.priceIlsMinor ||
        a.priceUsdMinor !== input.priceUsdMinor;
      const did = await updateColumns(
        tx,
        ctx,
        a,
        {
          priceIlsMinor: input.priceIlsMinor,
          priceUsdMinor: input.priceUsdMinor,
          priceOnRequest: input.priceOnRequest,
          offersEnabled: input.offersEnabled,
          offerAutoDeclineBelowIlsMinor: input.offerAutoDeclineBelowIlsMinor,
          ...(anyPriceMoved ? { priceChangedAt: new Date() } : {}),
        },
        priceChanged ? "artwork.price_changed" : "artwork.price_updated",
      );
      return { changed: did, priceChanged };
    },
    { db: deps.db, name: "catalog.price" },
  );
  return withEffects(out, out.changed ? { revalidate: true } : {});
}

export interface ArtworkShippingInput {
  packagingType: PackagingType;
  canBeRolled: boolean;
  packedLengthMm: number | null;
  packedWidthMm: number | null;
  packedHeightMm: number | null;
  packedWeightG: number | null;
  sizeClassOverride: "S" | "M" | "L" | "QUOTE" | null;
  shipsInternationally: boolean;
  localPickupOnly: boolean;
  quoteOnly: boolean;
  dispatchDays: number;
}

export async function updateArtworkShipping(
  ctx: AdminContext,
  id: string,
  input: ArtworkShippingInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ changed: boolean }>> {
  const did = await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      return updateColumns(tx, ctx, a, input, "artwork.shipping_updated");
    },
    { db: deps.db, name: "catalog.shipping" },
  );
  return withEffects({ changed: did }, did ? { revalidate: true } : {});
}

export interface ArtworkCustomsInput {
  hsCode: string;
  customsDescriptionEn: string | null;
  countryOfOrigin: string;
  declaredValueOverrideMinor: number | null;
  maxInsurableValueMinor: number | null;
  creditLine: string | null;
}

export async function updateArtworkCustoms(
  ctx: AdminContext,
  id: string,
  input: ArtworkCustomsInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ changed: boolean }>> {
  const did = await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      return updateColumns(tx, ctx, a, input, "artwork.customs_updated");
    },
    { db: deps.db, name: "catalog.customs" },
  );
  return withEffects({ changed: did }, did ? { revalidate: true } : {});
}

/** Deletes a work that was never published and never ordered (a draft created by mistake). */
export async function deleteDraftArtwork(
  ctx: AdminContext,
  id: string,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ deleted: true }>> {
  const store = deps.storage ?? defaultStorage();
  const keys = await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      if (a.publishedAt !== null || a.saleStatus === "SOLD") {
        throw new ConflictError(
          "NOT_A_DRAFT",
          "only never-published works can be deleted",
        );
      }
      const [item] = await tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(eq(orderItems.artworkId, id))
        .limit(1);
      const [sale] = await tx
        .select({ id: sales.id })
        .from(sales)
        .where(eq(sales.artworkId, id))
        .limit(1);
      if (item || sale || a.reservedByOrderId) {
        throw new ConflictError("HAS_ORDERS", "the work has orders or sales");
      }
      const images = await tx
        .select()
        .from(artworkImages)
        .where(eq(artworkImages.artworkId, id));
      await tx.delete(artworks).where(eq(artworks.id, id));
      await audit(
        {
          ...auditBy(ctx),
          action: "artwork.deleted",
          entity: "artwork",
          entityId: id,
          before: { slug: a.slug, titleEn: a.titleEn },
        },
        tx,
      );
      return images.flatMap((i) => imageFiles(i));
    },
    { db: deps.db, name: "catalog.delete" },
  );
  await deleteFiles(store, keys);
  return withEffects({ deleted: true }, { revalidate: true });
}

// ---------------------------------------------------------------- packing suggestion

/** Packaging type suggested by the surface (canvas and linen ship stretched; the rest flat). */
export function suggestedPackagingType(a: { surface: Surface }): PackagingType {
  return a.surface === "CANVAS" || a.surface === "LINEN"
    ? "STRETCHED_BOX"
    : "FLAT_BOX";
}

export interface PackingSuggestion {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: number;
}

/**
 * "Use suggestion" for the packed dimensions (spec §6.10 editor; the §8.3 packaging defaults):
 * artwork + 120 mm (+ 80 mm for paper) in length and width, depth (or frame depth) + 80 mm in
 * height, 1.5 kg + 6 kg per m² (+ 50 % framed or glazed); a tube for ROLLED_TUBE.
 */
export function packingSuggestion(a: {
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
  surface: Surface;
  framed: boolean;
  frameHeightMm: number | null;
  frameWidthMm: number | null;
  frameDepthMm: number | null;
  glazing: "NONE" | "GLASS" | "ACRYLIC";
  packagingType: PackagingType;
}): PackingSuggestion {
  const h = a.framed && a.frameHeightMm ? a.frameHeightMm : a.heightMm;
  const w = a.framed && a.frameWidthMm ? a.frameWidthMm : a.widthMm;
  const d =
    (a.framed && a.frameDepthMm ? a.frameDepthMm : a.depthMm) ??
    (a.surface === "PAPER" ? 2 : 30);
  const areaM2 = (h / 1000) * (w / 1000);
  const heavy = a.framed || a.glazing !== "NONE" ? 1.5 : 1;
  const weightG = Math.round((1500 + 6000 * areaM2) * heavy);
  if (a.packagingType === "ROLLED_TUBE") {
    return {
      lengthMm: Math.min(h, w) + 100,
      widthMm: 260,
      heightMm: 260,
      weightG,
    };
  }
  const margin =
    a.surface === "PAPER" && !a.framed
      ? 80
      : a.packagingType === "CRATE"
        ? 200
        : 120;
  return {
    lengthMm: h + margin,
    widthMm: w + margin,
    heightMm: d + 80,
    weightG,
  };
}

// ---------------------------------------------------------------- images

function imageFiles(i: {
  publicKey: string;
  originalKey: string | null;
  ogKey: string | null;
}): { key: string; access: "public" | "private" }[] {
  return [
    { key: i.publicKey, access: "public" as const },
    ...(i.ogKey ? [{ key: i.ogKey, access: "public" as const }] : []),
    ...(i.originalKey
      ? [{ key: i.originalKey, access: "private" as const }]
      : []),
  ];
}

async function deleteFiles(
  store: StorageAdapter,
  files: { key: string; access: "public" | "private" }[],
): Promise<void> {
  for (const f of files) {
    try {
      await store.delete(f.key, f.access);
    } catch (error) {
      log.warn("catalog.file_delete_failed", { key: f.key }, error);
    }
  }
}

async function imageOf(tx: Tx, imageId: string) {
  const [img] = await tx
    .select()
    .from(artworkImages)
    .where(eq(artworkImages.id, imageId));
  if (!img) throw new NotFoundError("artwork_image", imageId);
  return img;
}

export interface ArtworkImageInput {
  role: ImageRoleValue;
  altHe: string;
  altEn: string;
  creditLine: string | null;
}

/** Role, alt texts and credit of one image. Making an image MAIN demotes the previous MAIN. */
export async function updateArtworkImage(
  ctx: AdminContext,
  imageId: string,
  input: ArtworkImageInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ changed: boolean }>> {
  const did = await withTx(
    async (tx) => {
      const head = await imageOf(tx, imageId);
      const a = await lockOne(tx, head.artworkId);
      const img = await imageOf(tx, imageId);
      if (img.role === "MAIN" && input.role !== "MAIN" && a.isPublished) {
        throw new ConflictError(
          "MAIN_REQUIRED",
          "a published work needs a main image",
        );
      }
      if (input.role === "MAIN" && img.role !== "MAIN") {
        await tx
          .update(artworkImages)
          .set({ role: "DETAIL", updatedAt: new Date() })
          .where(
            and(
              eq(artworkImages.artworkId, a.id),
              eq(artworkImages.role, "MAIN"),
            ),
          );
      }
      const next = {
        role: input.role,
        altHe: input.altHe.trim(),
        altEn: input.altEn.trim(),
        creditLine: input.creditLine,
      };
      const diff = changed(img as unknown as Record<string, unknown>, next);
      if (Object.keys(diff.after).length === 0) return false;
      await tx
        .update(artworkImages)
        .set({ ...diff.after, updatedAt: new Date() })
        .where(eq(artworkImages.id, img.id));
      await audit(
        {
          ...auditBy(ctx),
          action: "artwork_image.updated",
          entity: "artwork",
          entityId: a.id,
          before: { imageId: img.id, ...diff.before },
          after: { imageId: img.id, ...diff.after },
        },
        tx,
      );
      return true;
    },
    { db: deps.db, name: "catalog.image" },
  );
  return withEffects({ changed: did }, did ? { revalidate: true } : {});
}

/** Moves an image one place earlier or later in the gallery order (renumbers 0..n-1). */
export async function moveArtworkImage(
  ctx: AdminContext,
  imageId: string,
  direction: "up" | "down",
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ moved: boolean }>> {
  const moved = await withTx(
    async (tx) => {
      const head = await imageOf(tx, imageId);
      await lockOne(tx, head.artworkId);
      const list = await tx
        .select({ id: artworkImages.id })
        .from(artworkImages)
        .where(eq(artworkImages.artworkId, head.artworkId))
        .orderBy(asc(artworkImages.sortOrder), asc(artworkImages.createdAt));
      const ids = list.map((r) => r.id);
      const at = ids.indexOf(imageId);
      const to = direction === "up" ? at - 1 : at + 1;
      if (at < 0 || to < 0 || to >= ids.length) return false;
      [ids[at], ids[to]] = [ids[to] as string, ids[at] as string];
      for (const [i, id] of ids.entries()) {
        await tx
          .update(artworkImages)
          .set({ sortOrder: i })
          .where(eq(artworkImages.id, id));
      }
      await audit(
        {
          ...auditBy(ctx),
          action: "artwork_image.reordered",
          entity: "artwork",
          entityId: head.artworkId,
          after: { order: ids },
        },
        tx,
      );
      return true;
    },
    { db: deps.db, name: "catalog.image_move" },
  );
  return withEffects({ moved }, moved ? { revalidate: true } : {});
}

export async function deleteArtworkImage(
  ctx: AdminContext,
  imageId: string,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ deleted: true }>> {
  const store = deps.storage ?? defaultStorage();
  const files = await withTx(
    async (tx) => {
      const head = await imageOf(tx, imageId);
      const a = await lockOne(tx, head.artworkId);
      const img = await imageOf(tx, imageId);
      if (img.role === "MAIN" && a.isPublished) {
        throw new ConflictError(
          "MAIN_REQUIRED",
          "a published work needs a main image",
        );
      }
      await tx.delete(artworkImages).where(eq(artworkImages.id, img.id));
      await audit(
        {
          ...auditBy(ctx),
          action: "artwork_image.deleted",
          entity: "artwork",
          entityId: a.id,
          before: { imageId: img.id, role: img.role },
        },
        tx,
      );
      return imageFiles(img);
    },
    { db: deps.db, name: "catalog.image_delete" },
  );
  await deleteFiles(store, files);
  return withEffects({ deleted: true }, { revalidate: true });
}

// ---------------------------------------------------------------- sale state (spec §5.9)

export interface OverrideOption {
  /** The admin confirmed the "A buyer is checking out until …" dialog. */
  confirmOverride?: boolean;
}

/**
 * Locks the artwork and, when another order holds it, that order's other artworks too (all in id
 * order, before the order row). Returns the locked artwork and its holder (if any).
 */
async function lockWithHolder(
  tx: Tx,
  id: string,
): Promise<{ a: Artwork; holder: string | null }> {
  const [peek] = await tx
    .select({ holder: artworks.reservedByOrderId })
    .from(artworks)
    .where(eq(artworks.id, id));
  if (!peek) throw new NotFoundError("artwork", id);
  const extra = peek.holder ? await orderArtworkIds(tx, peek.holder) : [];
  const locked = await lockArtworks(tx, [id, ...extra]);
  const a = locked.find((r) => r.id === id);
  if (!a) throw new NotFoundError("artwork", id);
  if (a.reservedByOrderId && a.reservedByOrderId !== peek.holder) {
    // Another buyer took the hold between the peek and the lock: ask the admin to try again.
    throw new ConflictError("HOLD_CHANGED", "the hold changed; try again");
  }
  return { a, holder: a.reservedByOrderId };
}

/**
 * Clears a checkout hold before an admin status change. A live hold needs `confirmOverride`; a
 * hold whose order is confirming a payment is never overridden. The holding order (when still
 * AWAITING_PAYMENT) becomes EXPIRED with reason `ADMIN`.
 */
async function clearCheckoutHold(
  tx: Tx,
  ctx: AdminContext,
  a: Artwork,
  holder: string | null,
  opts: OverrideOption,
): Promise<string | null> {
  if (!holder) return null;
  const inFlight = (await ordersWithAttemptInFlight(tx, [holder])).size > 0;
  const live =
    inFlight ||
    (a.reservedUntil !== null && a.reservedUntil.getTime() > Date.now());
  const order = await lockOrder(tx, holder);
  if (inFlight) {
    throw new ConflictError(
      "PAYMENT_IN_FLIGHT",
      "a payment for this work is being confirmed",
      { orderNumber: order?.number ?? null },
    );
  }
  if (live && !opts.confirmOverride) {
    throw new ConflictError("LIVE_HOLD", "a buyer is checking out this work", {
      until: a.reservedUntil?.toISOString() ?? null,
      orderNumber: order?.number ?? null,
    });
  }
  await releaseHoldsOf(tx, holder);
  if (order?.status === "AWAITING_PAYMENT") {
    await transition(
      tx,
      "order",
      order.id,
      ["AWAITING_PAYMENT"],
      "EXPIRED",
      { statusReason: "ADMIN", expiresAt: new Date() },
      ctx.actor,
      { action: "order.hold_overridden", ipHash: ctx.ipHash },
    );
  }
  return order?.id ?? holder;
}

export interface OfflineHoldInput extends OverrideOption {
  reason: HoldReason;
  note: string | null;
}

export async function setOfflineHold(
  ctx: AdminContext,
  id: string,
  input: OfflineHoldInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ expiredOrderId: string | null }>> {
  const expiredOrderId = await withTx(
    async (tx) => {
      const { a, holder } = await lockWithHolder(tx, id);
      if (a.saleStatus !== "AVAILABLE") {
        throw new ConflictError("NOT_AVAILABLE", "the work is not available", {
          status: a.saleStatus,
        });
      }
      const expired = await clearCheckoutHold(tx, ctx, a, holder, input);
      await transition(
        tx,
        "artwork",
        a.id,
        ["AVAILABLE"],
        "ON_HOLD",
        { holdReason: input.reason, holdNote: input.note },
        ctx.actor,
        { action: "artwork.offline_hold", ipHash: ctx.ipHash },
      );
      return expired;
    },
    { db: deps.db, name: "catalog.offline_hold" },
  );
  return withEffects({ expiredOrderId }, { revalidate: true });
}

export async function releaseOfflineHold(
  ctx: AdminContext,
  id: string,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ released: true }>> {
  await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      if (a.saleStatus !== "ON_HOLD") {
        throw new ConflictError("NOT_ON_HOLD", "the work is not on hold");
      }
      await transition(
        tx,
        "artwork",
        a.id,
        ["ON_HOLD"],
        "AVAILABLE",
        { holdReason: null, holdNote: null },
        ctx.actor,
        { action: "artwork.offline_hold_released", ipHash: ctx.ipHash },
      );
    },
    { db: deps.db, name: "catalog.release_hold" },
  );
  return withEffects({ released: true }, { revalidate: true });
}

export interface SoldOfflineInput extends OverrideOption {
  soldAt: Date;
  /** Defaults to the ILS list price (0 when the work has none). */
  priceMinor?: number | null;
  currency?: Currency | null;
  note: string | null;
}

/**
 * `markSoldOffline` (spec §5.9): inserts an OFFLINE sale (counts toward the turnover widget unless
 * the work is a demo work) and moves AVAILABLE / ON_HOLD → SOLD. The `sales` partial unique index
 * is the last line of defence against a second sale.
 */
export async function markSoldOffline(
  ctx: AdminContext,
  id: string,
  input: SoldOfflineInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ saleId: string; expiredOrderId: string | null }>> {
  const out = await withTx(
    async (tx) => {
      const { a, holder } = await lockWithHolder(tx, id);
      if (a.saleStatus !== "AVAILABLE" && a.saleStatus !== "ON_HOLD") {
        throw new ConflictError("NOT_SELLABLE", "the work cannot be sold", {
          status: a.saleStatus,
        });
      }
      const expired = await clearCheckoutHold(tx, ctx, a, holder, input);
      const currency = input.currency ?? "ILS";
      const priceMinor =
        input.priceMinor ??
        (currency === "ILS" ? a.priceIlsMinor : a.priceUsdMinor) ??
        0;
      let saleId: string;
      try {
        const [sale] = await tx
          .insert(sales)
          .values({
            artworkId: a.id,
            channel: "OFFLINE",
            priceMinor,
            currency,
            isMock: false,
            soldAt: input.soldAt,
            createdBy: ctx.actor,
          })
          .returning({ id: sales.id });
        if (!sale) throw new Error("sale insert returned no row");
        saleId = sale.id;
      } catch (error) {
        if (isUniqueViolation(error, "sales_one_active_per_artwork_idx")) {
          throw new ConflictError(
            "ALREADY_SOLD",
            "the work already has a sale",
          );
        }
        throw error;
      }
      await transition(
        tx,
        "artwork",
        a.id,
        [a.saleStatus],
        "SOLD",
        { soldAt: input.soldAt, holdReason: null, holdNote: null },
        ctx.actor,
        { action: "artwork.sold_offline", ipHash: ctx.ipHash },
      );
      await audit(
        {
          ...auditBy(ctx),
          action: "sale.recorded_offline",
          entity: "sale",
          entityId: saleId,
          after: {
            artworkId: a.id,
            priceMinor,
            currency,
            soldAt: input.soldAt.toISOString(),
            note: input.note,
          },
        },
        tx,
      );
      return { saleId, expiredOrderId: expired };
    },
    { db: deps.db, name: "catalog.sold_offline" },
  );
  return withEffects(out, { revalidate: true });
}

const OPEN_REFUND_STATUSES = [
  "REQUESTED",
  "IN_FLIGHT",
  "PROVIDER_PENDING",
  "UNKNOWN",
  "MANUAL_REQUIRED",
] as const;

/** Why a SOLD work cannot be relisted (or marked damaged) yet; null when it can. */
async function soldWorkBlocker(
  tx: Tx,
  saleRow: typeof sales.$inferSelect,
  allowDamaged: boolean,
): Promise<string | null> {
  if (saleRow.channel !== "ONLINE" || !saleRow.orderId) return null;
  const order = await lockOrder(tx, saleRow.orderId);
  if (order?.status !== "CANCELLED") return "ORDER_NOT_CANCELLED";
  const rows = await tx
    .select({
      status: refunds.status,
      failureConfirmedAt: refunds.failureConfirmedAt,
    })
    .from(refunds)
    .where(eq(refunds.orderId, order.id));
  const open = rows.some(
    (r) =>
      (OPEN_REFUND_STATUSES as readonly string[]).includes(r.status) ||
      (r.status === "FAILED" && r.failureConfirmedAt === null),
  );
  const settled = rows.some(
    (r) => r.status === "SUCCEEDED" || r.status === "MANUAL_DONE",
  );
  if (open || !settled) return "REFUND_NOT_SETTLED";
  const returns = await tx
    .select({ returnStatus: cancellations.returnStatus })
    .from(cancellations)
    .where(
      and(
        eq(cancellations.orderId, order.id),
        ne(cancellations.status, "REJECTED"),
      ),
    );
  const ok = new Set<string>(
    allowDamaged
      ? ["NOT_APPLICABLE", "INSPECTED_OK", "INSPECTED_DAMAGED"]
      : ["NOT_APPLICABLE", "INSPECTED_OK"],
  );
  if (returns.some((r) => !ok.has(r.returnStatus))) return "RETURN_PENDING";
  return null;
}

async function activeSaleOf(tx: Tx, artworkId: string) {
  const [row] = await tx
    .select()
    .from(sales)
    .where(and(eq(sales.artworkId, artworkId), isNull(sales.voidedAt)));
  return row ?? null;
}

export interface RelistInput {
  /** Required for an offline sale (spec §5.9 "An offline sale needs confirmation"). */
  confirm?: boolean;
  reason: string | null;
}

/**
 * Relist (spec §5.9): SOLD → AVAILABLE and the active sale voided. An online sale needs the order
 * CANCELLED, its refund settled and the return INSPECTED_OK or NOT_APPLICABLE; an offline sale
 * needs `confirm`. Always audited.
 */
export async function relistArtwork(
  ctx: AdminContext,
  id: string,
  input: RelistInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ voidedSaleId: string | null }>> {
  const voided = await withTx(
    async (tx) => voidSaleAndMove(tx, ctx, id, input, "AVAILABLE"),
    { db: deps.db, name: "catalog.relist" },
  );
  return withEffects({ voidedSaleId: voided }, { revalidate: true });
}

/** SOLD → NOT_FOR_SALE (a damaged return): the sale is voided like a relist. */
export async function markDamaged(
  ctx: AdminContext,
  id: string,
  input: RelistInput,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ voidedSaleId: string | null }>> {
  const voided = await withTx(
    async (tx) => voidSaleAndMove(tx, ctx, id, input, "NOT_FOR_SALE"),
    { db: deps.db, name: "catalog.damaged" },
  );
  return withEffects({ voidedSaleId: voided }, { revalidate: true });
}

async function voidSaleAndMove(
  tx: Tx,
  ctx: AdminContext,
  id: string,
  input: RelistInput,
  to: "AVAILABLE" | "NOT_FOR_SALE",
): Promise<string | null> {
  const a = await lockOne(tx, id);
  if (a.saleStatus !== "SOLD") {
    throw new ConflictError("NOT_SOLD", "the work is not sold");
  }
  const sale = await activeSaleOf(tx, a.id);
  if (sale) {
    const blocker = await soldWorkBlocker(tx, sale, to === "NOT_FOR_SALE");
    if (blocker)
      throw new ConflictError(blocker, "the sale cannot be voided yet");
    if (sale.channel === "OFFLINE" && !input.confirm) {
      throw new ConflictError(
        "CONFIRM_REQUIRED",
        "confirm voiding the offline sale",
      );
    }
    await tx
      .update(sales)
      .set({
        voidedAt: new Date(),
        voidReason: to === "AVAILABLE" ? "RELIST" : "DAMAGED",
      })
      .where(and(eq(sales.id, sale.id), isNull(sales.voidedAt)));
  }
  await transition(
    tx,
    "artwork",
    a.id,
    ["SOLD"],
    to,
    { soldAt: null },
    ctx.actor,
    {
      action: to === "AVAILABLE" ? "artwork.relisted" : "artwork.damaged",
      ipHash: ctx.ipHash,
    },
  );
  await audit(
    {
      ...auditBy(ctx),
      action: "sale.voided",
      entity: "sale",
      entityId: sale?.id ?? a.id,
      after: {
        artworkId: a.id,
        channel: sale?.channel ?? null,
        reason: input.reason,
        to,
      },
    },
    tx,
  );
  return sale?.id ?? null;
}

/** AVAILABLE / ON_HOLD → NOT_FOR_SALE (an ON_HOLD work goes through AVAILABLE, spec §3.6). */
export async function markNotForSale(
  ctx: AdminContext,
  id: string,
  input: OverrideOption = {},
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ expiredOrderId: string | null }>> {
  const expiredOrderId = await withTx(
    async (tx) => {
      const { a, holder } = await lockWithHolder(tx, id);
      if (a.saleStatus !== "AVAILABLE" && a.saleStatus !== "ON_HOLD") {
        throw new ConflictError("NOT_AVAILABLE", "the work is not available", {
          status: a.saleStatus,
        });
      }
      const expired = await clearCheckoutHold(tx, ctx, a, holder, input);
      if (a.saleStatus === "ON_HOLD") {
        await transition(
          tx,
          "artwork",
          a.id,
          ["ON_HOLD"],
          "AVAILABLE",
          { holdReason: null, holdNote: null },
          ctx.actor,
          { ipHash: ctx.ipHash, skipAudit: true },
        );
      }
      await transition(
        tx,
        "artwork",
        a.id,
        ["AVAILABLE"],
        "NOT_FOR_SALE",
        {},
        ctx.actor,
        { action: "artwork.not_for_sale", ipHash: ctx.ipHash },
      );
      return expired;
    },
    { db: deps.db, name: "catalog.not_for_sale" },
  );
  return withEffects({ expiredOrderId }, { revalidate: true });
}

/** NOT_FOR_SALE → AVAILABLE. */
export async function markForSale(
  ctx: AdminContext,
  id: string,
  deps: CatalogDeps = {},
): Promise<ServiceResult<{ available: true }>> {
  await withTx(
    async (tx) => {
      const a = await lockOne(tx, id);
      await transition(
        tx,
        "artwork",
        a.id,
        ["NOT_FOR_SALE"],
        "AVAILABLE",
        {},
        ctx.actor,
        { action: "artwork.for_sale", ipHash: ctx.ipHash },
      );
    },
    { db: deps.db, name: "catalog.for_sale" },
  );
  return withEffects({ available: true }, { revalidate: true });
}
