/**
 * Admin and request test factories (WS4-owned, spec §9.3 `factories/admin.ts`). App modules are
 * imported lazily, like `factories/core.ts`, so importing this file never parses the app env.
 */
import type { DbOrTx } from "@/server/db/client";
import { uniqueBuyer, uniqueSuffix } from "./core";

type Schema = typeof import("@/server/db/schema");
type AdminContext = import("@/server/domain/admin").AdminContext;
type ImageInsert = Schema["artworkImages"]["$inferInsert"];
type RequestInsert = Schema["buyerRequests"]["$inferInsert"];

/** An `AdminContext` as `requireAdmin()` would build it (tests only). */
export function adminCtx(
  overrides: Partial<Record<string, unknown>> = {},
): AdminContext {
  return {
    userId: "u-admin",
    email: "admin@example.test",
    name: "Admin",
    sessionId: "s-admin",
    sessionCreatedAt: new Date(),
    twoFactorEnabled: true,
    locale: "he",
    ipHash: null,
    actor: "admin:u-admin",
    ...overrides,
  } as unknown as AdminContext;
}

/** An `artwork_images` row without touching storage (keys are fake). */
export async function insertImage(
  db: DbOrTx,
  artworkId: string,
  overrides: Partial<ImageInsert> = {},
) {
  const { artworkImages } = await import("@/server/db/schema");
  const s = uniqueSuffix();
  const [row] = await db
    .insert(artworkImages)
    .values({
      artworkId,
      role: "MAIN",
      publicKey: `artworks/test/${s}.jpg`,
      width: 1200,
      height: 900,
      bytes: 1000,
      contentHash: s,
      altHe: "תיאור",
      altEn: "Description",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertImage: no row returned");
  return row;
}

/** The packing, customs and USD fields a carrier-shipped international work needs to publish. */
export const PUBLISHABLE = {
  priceUsdMinor: 40_000,
  packedLengthMm: 720,
  packedWidthMm: 920,
  packedHeightMm: 110,
  packedWeightG: 4_000,
  customsDescriptionEn: "Original oil painting on canvas",
} as const;

/** A NEW buyer request row (no emails; use `submitRequest` to test the full flow). */
export async function insertRequest(
  db: DbOrTx,
  overrides: Partial<RequestInsert> = {},
) {
  const { buyerRequests } = await import("@/server/db/schema");
  const buyer = uniqueBuyer("req");
  const [row] = await db
    .insert(buyerRequests)
    .values({
      kind: "QUESTION",
      name: buyer.name,
      email: buyer.email,
      locale: "en",
      message: "Is it still available?",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertRequest: no row returned");
  return row;
}
