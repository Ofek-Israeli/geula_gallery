import "server-only";
import { eq } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworks, orders, sales } from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { env as defaultEnv, type Env } from "@/server/env";
import { getSetting } from "@/server/settings";

/**
 * Data for the certificate of authenticity (spec §5.4 Printables, Tier B): one COA per active
 * sale (online or offline). Admin only (the buyer name is PII). The QR code points at the work's
 * public page.
 */
export interface CoaData {
  saleId: string;
  isDemo: boolean;
  isMock: boolean;
  title: string;
  inventoryNumber: string;
  yearCreated: number | null;
  mediumText: string;
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
  signed: boolean;
  soldAt: Date;
  buyerName: string | null;
  artistName: string;
  signatureName: string;
  artworkUrl: string;
}

export async function getCoaData(
  _ctx: AdminContext,
  saleId: string,
  locale: Locale,
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<CoaData | null> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const [row] = await db
    .select({ sale: sales, art: artworks })
    .from(sales)
    .innerJoin(artworks, eq(artworks.id, sales.artworkId))
    .where(eq(sales.id, saleId));
  if (!row) return null;
  const [order] = row.sale.orderId
    ? await db
        .select({ buyerName: orders.buyerName })
        .from(orders)
        .where(eq(orders.id, row.sale.orderId))
    : [];
  const profile = await getSetting("business_profile", db);
  const a = row.art;
  return {
    saleId,
    isDemo: a.isDemo,
    isMock: row.sale.isMock,
    title: locale === "he" ? a.titleHe : a.titleEn,
    inventoryNumber: a.inventoryNumber,
    yearCreated: a.yearCreated,
    mediumText: (locale === "he" ? a.mediumDetailHe : a.mediumDetailEn) ?? "",
    heightMm: a.heightMm,
    widthMm: a.widthMm,
    depthMm: a.depthMm,
    signed: a.signed,
    soldAt: row.sale.soldAt,
    buyerName: order?.buyerName ?? null,
    artistName: profile.artistName[locale],
    signatureName: profile.signatureName,
    artworkUrl: absoluteUrl(
      e.APP_URL,
      localePath(locale, paths.artwork(a.slug)),
    ),
  };
}
