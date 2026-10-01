import { connection } from "next/server";
import {
  IMMUTABLE_CACHE_CONTROL,
  keyFromSegments,
  storage,
} from "@/server/storage";

/**
 * Public files of the local storage driver (spec §4.6): web masters and OG images, immutable.
 * With the blob driver public objects live on the Blob CDN, so this route redirects there.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  await connection();
  const key = keyFromSegments((await params).key);
  if (!key) return new Response("Not found", { status: 404 });
  const store = storage();
  if (store.driver === "blob") {
    return Response.redirect(store.publicUrl(key), 308);
  }
  const object = await store.get(key, "public");
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.contentType,
      "Content-Length": String(object.size),
      "Cache-Control": IMMUTABLE_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
