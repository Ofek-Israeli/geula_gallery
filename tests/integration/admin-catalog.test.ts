import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { adminCtx, insertImage, PUBLISHABLE } from "../helpers/factories/admin";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { insertArtwork } from "../helpers/factories/core";

/**
 * Admin catalog services (spec §5.9, §6.10, §3.6 artwork machine): create, publish checklist and
 * slug lock, confirmed and audited price changes, image roles and ordering, offline hold / sale /
 * not-for-sale / relist, the live-checkout override (refused while a payment is in flight), and an
 * offline sale during a hold whose late payment is refunded.
 */
const { db } = await import("@/server/db/client");
const {
  artworks,
  artworkImages,
  auditLog,
  orders,
  refunds,
  sales,
  paymentAttempts,
} = await import("@/server/db/schema");
const m = await import("@/server/catalog/mutations");
const { publishArtwork, unpublishArtwork, publishChecklist } = await import(
  "@/server/catalog/publish"
);
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { getAdminArtwork, listAdminArtworks } = await import(
  "@/server/admin/catalog"
);

const ctx = adminCtx();
cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return "ok";
}

async function artwork(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!row) throw new Error("no artwork");
  return row;
}

describe("create and edit", () => {
  it("derives orientation and size bucket, slugifies the English title and refuses a taken slug", async () => {
    const { result } = await m.createArtwork(ctx, {
      titleHe: "שקיעה",
      titleEn: "Sunset, Jaffa",
      medium: "OIL",
      surface: "CANVAS",
      heightMm: 500,
      widthMm: 1200,
    });
    expect(result.slug).toBe("sunset-jaffa");
    const a = await artwork(result.id);
    expect(a.orientation).toBe("PANORAMIC");
    expect(a.sizeBucket).toBe("XL");
    expect(a.isPublished).toBe(false);
    expect(
      await code(
        m.createArtwork(ctx, {
          titleHe: "x",
          titleEn: "Sunset Jaffa",
          medium: "OIL",
          surface: "CANVAS",
          heightMm: 100,
          widthMm: 100,
        }),
      ),
    ).toBe("SLUG_TAKEN");
  });

  it("asks to confirm a price change and audits it", async () => {
    const a = await insertArtwork(db, { priceIlsMinor: 100_000 });
    const input = {
      priceIlsMinor: 120_000,
      priceUsdMinor: null,
      priceOnRequest: false,
      offersEnabled: false,
      offerAutoDeclineBelowIlsMinor: null,
    };
    expect(
      await code(
        m.updateArtworkPrice(ctx, a.id, {
          ...input,
          confirmPriceChange: false,
        }),
      ),
    ).toBe("PRICE_CONFIRM_REQUIRED");
    const out = await m.updateArtworkPrice(ctx, a.id, {
      ...input,
      confirmPriceChange: true,
    });
    expect(out.result.priceChanged).toBe(true);
    const after = await artwork(a.id);
    expect(after.priceIlsMinor).toBe(120_000);
    expect(after.priceChangedAt).not.toBeNull();
    const [row] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, a.id),
          eq(auditLog.action, "artwork.price_changed"),
        ),
      );
    expect(row?.before).toMatchObject({ priceIlsMinor: 100_000 });
    expect(row?.after).toMatchObject({ priceIlsMinor: 120_000 });
    // Setting a first price needs no confirmation.
    const b = await insertArtwork(db, { priceIlsMinor: null });
    expect(
      await code(
        m.updateArtworkPrice(ctx, b.id, {
          ...input,
          confirmPriceChange: false,
        }),
      ),
    ).toBe("ok");
  });
});

describe("publish checklist", () => {
  it("blocks publishing until photos with alt texts, packing, customs and USD price exist; then locks the slug", async () => {
    const a = await insertArtwork(db, {
      isPublished: false,
      publishedAt: null,
    });
    const missing = await m
      .updateArtworkShipping(ctx, a.id, {
        packagingType: "STRETCHED_BOX",
        canBeRolled: false,
        packedLengthMm: null,
        packedWidthMm: null,
        packedHeightMm: null,
        packedWeightG: null,
        sizeClassOverride: null,
        shipsInternationally: true,
        localPickupOnly: false,
        quoteOnly: false,
        dispatchDays: 5,
      })
      .then(() => publishArtwork(ctx, a.id))
      .catch((e) => e.details.missing as string[]);
    expect(missing).toEqual(
      expect.arrayContaining([
        "mainImage",
        "altTexts",
        "usdPrice",
        "packing",
        "customs",
      ]),
    );
    const img = await insertImage(db, a.id, { altEn: "" });
    await db.update(artworks).set(PUBLISHABLE).where(eq(artworks.id, a.id));
    const err = await publishArtwork(ctx, a.id).catch((e) => e);
    expect(err.code).toBe("PUBLISH_CHECKLIST");
    expect(err.details.missing).toEqual(["altTexts"]);
    await m.updateArtworkImage(ctx, img.id, {
      role: "MAIN",
      altHe: "תיאור",
      altEn: "A painting",
      creditLine: null,
    });
    await publishArtwork(ctx, a.id);
    const published = await artwork(a.id);
    expect(published.isPublished).toBe(true);
    expect(published.publishedAt).not.toBeNull();
    const details = {
      titleHe: a.titleHe,
      titleEn: a.titleEn,
      slug: "renamed",
      descriptionHe: "",
      descriptionEn: "",
      yearCreated: null,
      medium: "OIL" as const,
      surface: "CANVAS" as const,
      mediumDetailHe: null,
      mediumDetailEn: null,
      seriesId: null,
      featured: false,
      sortOrder: 0,
    };
    expect(await code(m.updateArtworkDetails(ctx, a.id, details))).toBe(
      "SLUG_LOCKED",
    );
    // The editor detail reports the checklist as complete.
    const d = await getAdminArtwork(ctx, a.id);
    expect(d?.checklist.every((i) => i.ok)).toBe(true);
  });

  it("pickup-only and price-on-request works need no packing, customs or USD price", () => {
    const items = publishChecklist(
      {
        titleHe: "a",
        titleEn: "b",
        slug: "a-b",
        priceIlsMinor: null,
        priceUsdMinor: null,
        priceOnRequest: true,
        quoteOnly: false,
        localPickupOnly: true,
        shipsInternationally: true,
        packedLengthMm: null,
        packedWidthMm: null,
        packedHeightMm: null,
        packedWeightG: null,
        customsDescriptionEn: null,
      },
      [{ role: "MAIN", altHe: "א", altEn: "a" }],
    );
    expect(items.every((i) => i.ok)).toBe(true);
    expect(items.filter((i) => !i.applies).map((i) => i.key)).toEqual([
      "usdPrice",
      "packing",
      "customs",
    ]);
  });

  it("refuses to unpublish while a buyer holds the work", async () => {
    const a = await buyableArtwork(db);
    await heldOrder(a.slug);
    expect(await code(unpublishArtwork(ctx, a.id))).toBe("LIVE_HOLD");
  });
});

describe("images", () => {
  it("making a detail MAIN demotes the old MAIN; move and delete renumber", async () => {
    const a = await insertArtwork(db, {
      isPublished: false,
      publishedAt: null,
    });
    const main = await insertImage(db, a.id, { sortOrder: 0 });
    const detail = await insertImage(db, a.id, {
      role: "DETAIL",
      sortOrder: 1,
    });
    await m.updateArtworkImage(ctx, detail.id, {
      role: "MAIN",
      altHe: "א",
      altEn: "a",
      creditLine: null,
    });
    const roles = await db
      .select({ id: artworkImages.id, role: artworkImages.role })
      .from(artworkImages)
      .where(eq(artworkImages.artworkId, a.id));
    expect(roles.find((r) => r.id === main.id)?.role).toBe("DETAIL");
    expect(roles.find((r) => r.id === detail.id)?.role).toBe("MAIN");
    await m.moveArtworkImage(ctx, detail.id, "up");
    const d = await getAdminArtwork(ctx, a.id);
    expect(d?.images.map((i) => i.id)).toEqual([detail.id, main.id]);
    await m.deleteArtworkImage(ctx, main.id, {
      storage: { delete: async () => {} } as never,
    });
    expect((await getAdminArtwork(ctx, a.id))?.images).toHaveLength(1);
  });

  it("refuses to remove the main image of a published work", async () => {
    const a = await insertArtwork(db);
    const main = await insertImage(db, a.id);
    expect(
      await code(
        m.deleteArtworkImage(ctx, main.id, {
          storage: { delete: async () => {} } as never,
        }),
      ),
    ).toBe("MAIN_REQUIRED");
  });
});

describe("offline hold, sale and relist (spec §5.9)", () => {
  it("hold → release → sold offline → relist (offline needs confirmation)", async () => {
    const a = await insertArtwork(db);
    await m.setOfflineHold(ctx, a.id, {
      reason: "EXHIBITION",
      note: "Gallery X",
    });
    let row = await artwork(a.id);
    expect(row.saleStatus).toBe("ON_HOLD");
    expect(row.holdReason).toBe("EXHIBITION");
    await m.releaseOfflineHold(ctx, a.id);
    expect((await artwork(a.id)).saleStatus).toBe("AVAILABLE");

    const soldAt = new Date("2026-09-15T09:00:00Z");
    const { result } = await m.markSoldOffline(ctx, a.id, {
      soldAt,
      priceMinor: 90_000,
      currency: "ILS",
      note: "studio visit",
    });
    row = await artwork(a.id);
    expect(row.saleStatus).toBe("SOLD");
    expect(row.soldAt?.toISOString()).toBe(soldAt.toISOString());
    const [sale] = await db
      .select()
      .from(sales)
      .where(eq(sales.id, result.saleId));
    expect(sale).toMatchObject({
      channel: "OFFLINE",
      priceMinor: 90_000,
      isMock: false,
    });
    expect(
      await code(m.markSoldOffline(ctx, a.id, { soldAt, note: null })),
    ).toBe("NOT_SELLABLE");

    expect(await code(m.relistArtwork(ctx, a.id, { reason: null }))).toBe(
      "CONFIRM_REQUIRED",
    );
    await m.relistArtwork(ctx, a.id, {
      confirm: true,
      reason: "buyer withdrew",
    });
    row = await artwork(a.id);
    expect(row.saleStatus).toBe("AVAILABLE");
    expect(row.soldAt).toBeNull();
    const active = await db
      .select()
      .from(sales)
      .where(and(eq(sales.artworkId, a.id), isNull(sales.voidedAt)));
    expect(active).toHaveLength(0);
  });

  it("not for sale goes through AVAILABLE from ON_HOLD and back", async () => {
    const a = await insertArtwork(db);
    await m.setOfflineHold(ctx, a.id, { reason: "OTHER", note: null });
    await m.markNotForSale(ctx, a.id);
    expect((await artwork(a.id)).saleStatus).toBe("NOT_FOR_SALE");
    expect((await artwork(a.id)).holdReason).toBeNull();
    await m.markForSale(ctx, a.id);
    expect((await artwork(a.id)).saleStatus).toBe("AVAILABLE");
  });

  it("a live checkout hold needs confirmation; confirming expires that order (ADMIN)", async () => {
    const a = await buyableArtwork(db);
    const h = await heldOrder(a.slug);
    expect(
      await code(
        m.setOfflineHold(ctx, a.id, { reason: "RESERVED_OFFLINE", note: null }),
      ),
    ).toBe("LIVE_HOLD");
    const out = await m.setOfflineHold(ctx, a.id, {
      reason: "RESERVED_OFFLINE",
      note: null,
      confirmOverride: true,
    });
    expect(out.result.expiredOrderId).toBe(h.orderId);
    const row = await artwork(a.id);
    expect(row.saleStatus).toBe("ON_HOLD");
    expect(row.reservedByOrderId).toBeNull();
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    expect(order).toMatchObject({ status: "EXPIRED", statusReason: "ADMIN" });
  });

  it("is refused while the holder's payment is being confirmed, even with confirmation", async () => {
    const a = await buyableArtwork(db);
    const h = await heldOrder(a.slug);
    await execSql(
      "UPDATE payment_attempts SET status = 'PAYMENT_REVIEW' WHERE id = $1",
      [h.attemptId],
    );
    expect(
      await code(
        m.markSoldOffline(ctx, a.id, {
          soldAt: new Date(),
          note: null,
          confirmOverride: true,
        }),
      ),
    ).toBe("PAYMENT_IN_FLIGHT");
    expect((await artwork(a.id)).saleStatus).toBe("AVAILABLE");
  });

  it("an offline sale during a hold: the buyer's later payment is refunded, the sale stays", async () => {
    const a = await buyableArtwork(db);
    const h = await heldOrder(a.slug);
    await m.markSoldOffline(ctx, a.id, {
      soldAt: new Date(),
      note: null,
      confirmOverride: true,
    });
    await clickMockPay(h.ref, "pay");
    const out = await finalizeAttempt(h.attemptId, { trigger: "return" });
    expect(out.result.outcome).toBe("needs_refund");
    const [attempt] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    expect(attempt?.status).toBe("NEEDS_REFUND");
    const rows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, h.orderId));
    expect(rows).toHaveLength(1);
    const active = await db
      .select()
      .from(sales)
      .where(and(eq(sales.artworkId, a.id), isNull(sales.voidedAt)));
    expect(active).toHaveLength(1);
    expect(active[0]?.channel).toBe("OFFLINE");
  });

  it("an online sale cannot be relisted before the order is cancelled and refunded", async () => {
    const a = await buyableArtwork(db);
    const h = await heldOrder(a.slug);
    await clickMockPay(h.ref, "pay");
    await finalizeAttempt(h.attemptId, { trigger: "return" });
    expect((await artwork(a.id)).saleStatus).toBe("SOLD");
    expect(
      await code(m.relistArtwork(ctx, a.id, { confirm: true, reason: null })),
    ).toBe("ORDER_NOT_CANCELLED");
  });
});

describe("admin list", () => {
  it("filters drafts and searches titles", async () => {
    const a = await insertArtwork(db, {
      isPublished: false,
      publishedAt: null,
      titleEn: "Blue Hour",
    });
    await insertArtwork(db);
    const drafts = await listAdminArtworks(ctx, { filter: "draft" });
    expect(drafts.rows.map((r) => r.id)).toEqual([a.id]);
    const found = await listAdminArtworks(ctx, { q: "blue hour" });
    expect(found.rows.map((r) => r.id)).toEqual([a.id]);
  });
});
