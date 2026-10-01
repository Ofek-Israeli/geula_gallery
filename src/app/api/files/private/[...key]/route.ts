import { connection } from "next/server";
import { AdminRouteError, requireAdminForRoute } from "@/server/next/guards";
import {
  keyFromSegments,
  PRIVATE_CACHE_CONTROL,
  storage,
  verifyPrivateFileToken,
} from "@/server/storage";

/**
 * Private files (spec §4.6, §7): originals, labels, invoices, packing and return photos, PDFs and
 * receipts. Reachable with a signed URL (`?t=`, ≤ 10 min) or an admin session; served
 * `private, no-store` as an attachment.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  await connection();
  const key = keyFromSegments((await params).key);
  if (!key) return new Response("Not found", { status: 404 });

  const token = new URL(request.url).searchParams.get("t");
  if (token) {
    if (!verifyPrivateFileToken(key, token)) {
      return new Response("Forbidden", {
        status: 403,
        headers: { "Cache-Control": PRIVATE_CACHE_CONTROL },
      });
    }
  } else {
    try {
      await requireAdminForRoute(request);
    } catch (error) {
      if (error instanceof AdminRouteError) {
        return new Response("Unauthorized", {
          status: error.status,
          headers: { "Cache-Control": PRIVATE_CACHE_CONTROL },
        });
      }
      throw error;
    }
  }

  const object = await storage().get(key, "private");
  if (!object) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": PRIVATE_CACHE_CONTROL },
    });
  }
  const filename = key.split("/").pop() ?? "file";
  return new Response(object.body, {
    headers: {
      "Content-Type": object.contentType,
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": PRIVATE_CACHE_CONTROL,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
