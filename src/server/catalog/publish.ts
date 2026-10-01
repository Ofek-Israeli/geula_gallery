import "server-only";
import { asc, eq } from "drizzle-orm";
import { isSlug } from "@/lib/validation/identifiers";
import { audit, auditBy } from "@/server/audit";
import {
  lockArtworks,
  ordersWithAttemptInFlight,
} from "@/server/checkout/reservations";
import type { Db, Tx } from "@/server/db/client";
import {
  type Artwork,
  type ArtworkImage,
  artworkImages,
  artworks,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, NotFoundError } from "@/server/domain/errors";

/**
 * Publish checklist and publish / unpublish (spec §3.6 "Publishing requires the publish checklist.
 * Unpublishing is refused while a live hold exists", §6.10 editor "Publish checklist", §2.5 "slugs
 * immutable after the first publish").
 *
 * The checklist is pure so the editor can show it live and the publish action re-checks it under
 * the artwork lock.
 */
export const CHECKLIST_KEYS = [
  "titles",
  "slug",
  "mainImage",
  "altTexts",
  "price",
  "usdPrice",
  "packing",
  "customs",
] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

export interface ChecklistItem {
  key: ChecklistKey;
  ok: boolean;
  /** False for items that do not apply to this work (shown as "not needed"). */
  applies: boolean;
}

type ChecklistArtwork = Pick<
  Artwork,
  | "titleHe"
  | "titleEn"
  | "slug"
  | "priceIlsMinor"
  | "priceUsdMinor"
  | "priceOnRequest"
  | "quoteOnly"
  | "localPickupOnly"
  | "shipsInternationally"
  | "packedLengthMm"
  | "packedWidthMm"
  | "packedHeightMm"
  | "packedWeightG"
  | "customsDescriptionEn"
>;
type ChecklistImage = Pick<ArtworkImage, "role" | "altHe" | "altEn">;

const filled = (v: string | null | undefined) => (v ?? "").trim().length > 0;

export function publishChecklist(
  a: ChecklistArtwork,
  images: readonly ChecklistImage[],
): ChecklistItem[] {
  /** Sold through checkout at a list price (not price on request, not quote only). */
  const listed = !a.priceOnRequest && !a.quoteOnly;
  const shipsByCarrier = !a.localPickupOnly && !a.quoteOnly;
  const international = a.shipsInternationally && !a.localPickupOnly;
  return [
    {
      key: "titles",
      applies: true,
      ok: filled(a.titleHe) && filled(a.titleEn),
    },
    { key: "slug", applies: true, ok: isSlug(a.slug) },
    {
      key: "mainImage",
      applies: true,
      ok: images.some((i) => i.role === "MAIN"),
    },
    {
      key: "altTexts",
      applies: true,
      ok:
        images.length > 0 &&
        images.every((i) => filled(i.altHe) && filled(i.altEn)),
    },
    {
      key: "price",
      applies: true,
      ok: !listed || a.priceIlsMinor !== null,
    },
    {
      key: "usdPrice",
      applies: listed && international,
      ok: !(listed && international) || a.priceUsdMinor !== null,
    },
    {
      key: "packing",
      applies: shipsByCarrier,
      ok:
        !shipsByCarrier ||
        (a.packedLengthMm !== null &&
          a.packedWidthMm !== null &&
          a.packedHeightMm !== null &&
          a.packedWeightG !== null),
    },
    {
      key: "customs",
      applies: international,
      ok: !international || filled(a.customsDescriptionEn),
    },
  ];
}

export function missingChecklistItems(items: readonly ChecklistItem[]) {
  return items.filter((i) => !i.ok).map((i) => i.key);
}

async function imagesOf(db: Db | Tx, artworkId: string) {
  return db
    .select()
    .from(artworkImages)
    .where(eq(artworkImages.artworkId, artworkId))
    .orderBy(asc(artworkImages.sortOrder), asc(artworkImages.createdAt));
}

/** A live hold: held by an order whose hold has not lapsed, or whose payment is in flight. */
export async function liveHoldOf(
  tx: Tx | Db,
  a: Pick<Artwork, "reservedByOrderId" | "reservedUntil">,
  now = new Date(),
): Promise<{ orderId: string; until: Date; inFlight: boolean } | null> {
  if (!a.reservedByOrderId || !a.reservedUntil) return null;
  const inFlight =
    (await ordersWithAttemptInFlight(tx, [a.reservedByOrderId])).size > 0;
  if (!inFlight && a.reservedUntil.getTime() <= now.getTime()) return null;
  return { orderId: a.reservedByOrderId, until: a.reservedUntil, inFlight };
}

export interface PublishDeps {
  db?: Db;
}

export async function publishArtwork(
  ctx: AdminContext,
  artworkId: string,
  deps: PublishDeps = {},
): Promise<ServiceResult<{ published: true }>> {
  await withTx(
    async (tx) => {
      const [a] = await lockArtworks(tx, [artworkId]);
      if (!a) throw new NotFoundError("artwork", artworkId);
      if (a.isPublished) return;
      const missing = missingChecklistItems(
        publishChecklist(a, await imagesOf(tx, a.id)),
      );
      if (missing.length > 0) {
        throw new ConflictError(
          "PUBLISH_CHECKLIST",
          "the publish checklist is incomplete",
          { missing },
        );
      }
      const now = new Date();
      await tx
        .update(artworks)
        .set({ isPublished: true, publishedAt: a.publishedAt ?? now })
        .where(eq(artworks.id, a.id));
      await audit(
        {
          ...auditBy(ctx),
          action: "artwork.published",
          entity: "artwork",
          entityId: a.id,
          after: { slug: a.slug, firstPublish: a.publishedAt === null },
        },
        tx,
      );
    },
    { db: deps.db, name: "catalog.publish" },
  );
  return withEffects({ published: true }, { revalidate: true });
}

export async function unpublishArtwork(
  ctx: AdminContext,
  artworkId: string,
  deps: PublishDeps = {},
): Promise<ServiceResult<{ published: false }>> {
  await withTx(
    async (tx) => {
      const [a] = await lockArtworks(tx, [artworkId]);
      if (!a) throw new NotFoundError("artwork", artworkId);
      if (!a.isPublished) return;
      const hold = await liveHoldOf(tx, a);
      if (hold) {
        throw new ConflictError(
          "LIVE_HOLD",
          "a buyer is checking out this work",
          { until: hold.until.toISOString(), inFlight: hold.inFlight },
        );
      }
      await tx
        .update(artworks)
        .set({ isPublished: false })
        .where(eq(artworks.id, a.id));
      await audit(
        {
          ...auditBy(ctx),
          action: "artwork.unpublished",
          entity: "artwork",
          entityId: a.id,
        },
        tx,
      );
    },
    { db: deps.db, name: "catalog.unpublish" },
  );
  return withEffects({ published: false }, { revalidate: true });
}
