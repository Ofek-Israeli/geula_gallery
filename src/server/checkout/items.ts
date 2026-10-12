import "server-only";
import type { Currency } from "@/lib/money";
import { type ActiveSale, applySale, percentOffFor } from "@/lib/sale";
import type { orderItems } from "@/server/db/schema";
import type { LockedArtwork } from "./reservations";

/**
 * The immutable `order_items` row of an artwork (spec §3.3: items never change after insert; the
 * snapshot feeds the disclosure document, receipts and the customs paperwork). Shared by the WEB
 * checkout and link orders so both record the same facts. During a sale the declared value is the
 * sale price (the price actually paid) and the snapshot keeps the list price and the percentage.
 */
export function orderItemValues(
  orderId: string,
  art: LockedArtwork,
  priceMinor: number,
  currency: Currency,
  sale: ActiveSale | null = null,
): typeof orderItems.$inferInsert {
  return {
    orderId,
    artworkId: art.id,
    titleHe: art.titleHe,
    titleEn: art.titleEn,
    priceMinor,
    currency,
    declaredValueMinor:
      art.declaredValueOverrideMinor ??
      applySale(art.priceIlsMinor, sale, art.id),
    snapshot: {
      slug: art.slug,
      inventoryNumber: art.inventoryNumber,
      heightMm: art.heightMm,
      widthMm: art.widthMm,
      depthMm: art.depthMm,
      medium: art.medium,
      surface: art.surface,
      yearCreated: art.yearCreated,
      mediumDetailHe: art.mediumDetailHe,
      mediumDetailEn: art.mediumDetailEn,
      framed: art.framed,
      signed: art.signed,
      coaIncluded: art.coaIncluded,
      isDemo: art.isDemo,
      ...(sale
        ? {
            sale: {
              percentOff: percentOffFor(sale, art.id),
              listPriceMinor:
                currency === "ILS" ? art.priceIlsMinor : art.priceUsdMinor,
            },
          }
        : {}),
    },
  };
}
