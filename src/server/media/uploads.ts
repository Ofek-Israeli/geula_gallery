import "server-only";
import { and, eq, max } from "drizzle-orm";
import { audit, auditBy } from "@/server/audit";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworkImages, artworks } from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
} from "@/server/domain/errors";
import { log } from "@/server/log";
import {
  artworkImageKeys,
  storage as defaultStorage,
  IMMUTABLE_CACHE_CONTROL,
  newPrivatePhotoKey,
  type StorageAdapter,
  type UploadPurpose,
} from "@/server/storage";
import { ingestArtworkImage, ingestPrivatePhoto } from "./ingest";

/**
 * The upload contract (spec §4.6, §9.3, frozen): `POST /api/admin/uploads?purpose=…` →
 * `{ fileKey, imageId? }`.
 * - `artwork`: full ingest; requires `artworkId`; creates the `artwork_images` row (so `imageId` is
 *   returned) with the public master, the private original and, for the MAIN image, the OG image.
 *   Alt texts start empty and are required by the publish checklist (WS4).
 * - `packing` / `return`: private photo only; the caller attaches `fileKey` to the shipment or the
 *   cancellation through a Server Action (keys only, never bytes).
 */
export const UPLOAD_PURPOSES = ["artwork", "packing", "return"] as const;
export type { UploadPurpose };

export type ImageRole =
  | "MAIN"
  | "DETAIL"
  | "EDGE"
  | "BACK"
  | "FRAMED"
  | "IN_ROOM"
  | "PROCESS";

export interface UploadInput {
  purpose: UploadPurpose;
  bytes: Uint8Array;
  /** Required for `artwork`. */
  artworkId?: string;
  /** `artwork` only; defaults to MAIN when the artwork has none, otherwise DETAIL. */
  role?: ImageRole;
}

export interface UploadResult {
  fileKey: string;
  imageId?: string;
}

const MAIN_INDEX = "artwork_images_one_main_idx";

export async function handleUpload(
  ctx: AdminContext,
  input: UploadInput,
  deps: { db?: DbOrTx; storage?: StorageAdapter } = {},
): Promise<ServiceResult<UploadResult>> {
  const db = deps.db ?? defaultDb;
  const store = deps.storage ?? defaultStorage();

  if (input.purpose !== "artwork") {
    const photo = await ingestPrivatePhoto(input.bytes);
    const key = newPrivatePhotoKey(input.purpose);
    await store.put(key, photo.body, {
      access: "private",
      contentType: "image/jpeg",
    });
    await audit(
      {
        ...auditBy(ctx),
        action: `upload.${input.purpose}`,
        entity: "file",
        entityId: key,
        after: { bytes: photo.bytes, width: photo.width, height: photo.height },
      },
      db,
    );
    return withEffects({ fileKey: key });
  }

  const artworkId = input.artworkId;
  if (!artworkId) throw new NotFoundError("artwork");
  const [artwork] = await db
    .select({ id: artworks.id })
    .from(artworks)
    .where(eq(artworks.id, artworkId))
    .limit(1);
  if (!artwork) throw new NotFoundError("artwork", artworkId);

  const [existing] = await db
    .select({ maxSort: max(artworkImages.sortOrder) })
    .from(artworkImages)
    .where(eq(artworkImages.artworkId, artworkId));
  const [main] = await db
    .select({ id: artworkImages.id })
    .from(artworkImages)
    .where(
      and(
        eq(artworkImages.artworkId, artworkId),
        eq(artworkImages.role, "MAIN"),
      ),
    )
    .limit(1);
  const roleDefaulted = input.role === undefined;
  let role: ImageRole = input.role ?? (main ? "DETAIL" : "MAIN");
  if (role === "MAIN" && main && !roleDefaulted) {
    throw new ConflictError(
      "MAIN_EXISTS",
      "the artwork already has a MAIN image",
    );
  }

  const image = await ingestArtworkImage(input.bytes);
  const keys = artworkImageKeys(
    artworkId,
    image.contentHash,
    image.original.ext,
  );
  const written: { key: string; access: "public" | "private" }[] = [];
  const put = async (
    key: string,
    body: Uint8Array,
    access: "public" | "private",
    contentType: string,
  ) => {
    await store.put(key, body, {
      access,
      contentType,
      cacheControl: access === "public" ? IMMUTABLE_CACHE_CONTROL : undefined,
    });
    written.push({ key, access });
  };

  try {
    await put(
      keys.original,
      image.original.body,
      "private",
      image.original.contentType,
    );
    await put(keys.master, image.master.body, "public", "image/jpeg");
    if (role === "MAIN")
      await put(keys.og, image.og.body, "public", "image/jpeg");

    const values = {
      artworkId,
      sortOrder: (existing?.maxSort ?? -1) + 1,
      publicKey: keys.master,
      originalKey: keys.original,
      width: image.master.width,
      height: image.master.height,
      bytes: image.master.bytes,
      contentHash: image.contentHash,
      blurDataUrl: image.blurDataUrl,
      dominantColor: image.dominantColor,
    };
    let row: { id: string } | undefined;
    try {
      [row] = await db
        .insert(artworkImages)
        .values({ ...values, role, ogKey: role === "MAIN" ? keys.og : null })
        .returning({ id: artworkImages.id });
    } catch (error) {
      // Two first uploads raced for MAIN: the loser becomes a DETAIL image.
      if (!(roleDefaulted && isUniqueViolation(error, MAIN_INDEX))) throw error;
      role = "DETAIL";
      [row] = await db
        .insert(artworkImages)
        .values({ ...values, role, ogKey: null })
        .returning({ id: artworkImages.id });
    }
    if (!row) throw new Error("artwork_images insert returned no row");

    await audit(
      {
        ...auditBy(ctx),
        action: "artwork_image.uploaded",
        entity: "artwork",
        entityId: artworkId,
        after: {
          imageId: row.id,
          role,
          width: values.width,
          height: values.height,
        },
      },
      db,
    );
    return withEffects(
      { fileKey: keys.master, imageId: row.id },
      { revalidate: true },
    );
  } catch (error) {
    if (isUniqueViolation(error, MAIN_INDEX)) {
      await cleanup(store, written);
      throw new ConflictError(
        "MAIN_EXISTS",
        "the artwork already has a MAIN image",
      );
    }
    await cleanup(store, written);
    throw error;
  }
}

async function cleanup(
  store: StorageAdapter,
  written: { key: string; access: "public" | "private" }[],
): Promise<void> {
  for (const w of written) {
    try {
      await store.delete(w.key, w.access);
    } catch (error) {
      log.warn("upload.cleanup_failed", { key: w.key }, error);
    }
  }
}
