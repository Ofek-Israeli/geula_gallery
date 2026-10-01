import { z } from "zod";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  UnsupportedImageError,
} from "@/server/media/ingest";
import { handleUpload, UPLOAD_PURPOSES } from "@/server/media/uploads";
import { applyEffects } from "@/server/next/effects";
import { adminRoute } from "@/server/next/guards";

/**
 * `POST /api/admin/uploads?purpose=artwork|packing|return` (spec §4.6, frozen contract).
 * Multipart with a `file` field (JPEG/PNG/WebP, ≤ 30 MB); `artwork` also takes `artworkId` and an
 * optional `role`. Guarded by `adminRoute` → `requireAdminForRoute` (session + same-origin check).
 * Returns `{ fileKey, imageId? }`.
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
/** Multipart framing overhead allowed on top of the file limit. */
const MULTIPART_SLACK = 1024 * 1024;

const fieldsSchema = z.object({
  purpose: z.enum(UPLOAD_PURPOSES),
  artworkId: z.uuid().optional(),
  role: z
    .enum(["MAIN", "DETAIL", "EDGE", "BACK", "FRAMED", "IN_ROOM", "PROCESS"])
    .optional(),
});

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

export const POST = adminRoute(async (request, ctx) => {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES + MULTIPART_SLACK)
    return fail(413, "TOO_LARGE");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "BAD_MULTIPART");
  }
  const url = new URL(request.url);
  const parsed = fieldsSchema.safeParse({
    purpose: url.searchParams.get("purpose") ?? undefined,
    artworkId: form.get("artworkId") || undefined,
    role: form.get("role") || undefined,
  });
  if (!parsed.success) return fail(400, "BAD_REQUEST");
  const { purpose, artworkId, role } = parsed.data;
  if (purpose === "artwork" && !artworkId)
    return fail(400, "ARTWORK_ID_REQUIRED");

  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "FILE_REQUIRED");
  if (file.size > MAX_UPLOAD_BYTES) return fail(413, "TOO_LARGE");
  if (file.type && !ACCEPTED_MIME_TYPES.includes(file.type)) {
    return fail(415, "UNSUPPORTED_TYPE");
  }

  try {
    const { result, effects } = await handleUpload(ctx, {
      purpose,
      artworkId,
      role,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    applyEffects(effects);
    return Response.json(result, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof UnsupportedImageError) {
      if (error.reason === "too_large") return fail(413, "TOO_LARGE");
      if (error.reason === "format") return fail(415, "UNSUPPORTED_TYPE");
      return fail(422, "UNREADABLE_IMAGE");
    }
    if (error instanceof NotFoundError) return fail(404, "ARTWORK_NOT_FOUND");
    if (error instanceof ConflictError) return fail(409, error.code);
    throw error;
  }
});
