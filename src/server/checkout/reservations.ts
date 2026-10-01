import "server-only";
import { asc, inArray } from "drizzle-orm";
import type { Tx } from "@/server/db/client";
import { artworks } from "@/server/db/schema";

/**
 * Reservation rules (spec §3.5; frozen contract). `lockArtworks` is the first step of every
 * transaction that touches artworks (global lock order; lock before any FK insert). The predicates
 * are evaluated on the locked rows; the conditional UPDATE repeats them in SQL (M2).
 */
export type LockedArtwork = typeof artworks.$inferSelect;

/** `SELECT … FROM artworks WHERE id = ANY($ids) ORDER BY id FOR UPDATE`. */
export async function lockArtworks(
  tx: Tx,
  ids: readonly string[],
): Promise<LockedArtwork[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)].sort();
  return tx
    .select()
    .from(artworks)
    .where(inArray(artworks.id, unique))
    .orderBy(asc(artworks.id))
    .for("update");
}

export interface HoldContext {
  /** The order trying to hold or pay. */
  orderId: string | null;
  now: Date;
  /**
   * Whether the order currently holding the work has an attempt in CAPTURING or PAYMENT_REVIEW
   * (the "in-flight foreign hold" predicate). Query it with the rows locked.
   */
  foreignHoldInFlight: boolean;
}

function holdAvailable(a: LockedArtwork, c: HoldContext): boolean {
  if (a.reservedByOrderId === null) return true;
  if (c.orderId !== null && a.reservedByOrderId === c.orderId) return true;
  return (
    a.reservedUntil !== null &&
    a.reservedUntil.getTime() <= c.now.getTime() &&
    !c.foreignHoldInFlight
  );
}

/**
 * Reservable for order `$o`: published, AVAILABLE, and free / ours / an expired foreign hold that
 * is not in flight. WEB checkout additionally requires `NOT quote_only AND NOT price_on_request`
 * (link orders created by the admin may bypass both).
 */
export function isReservable(
  a: LockedArtwork,
  c: HoldContext & { web: boolean },
): boolean {
  if (!a.isPublished || a.saleStatus !== "AVAILABLE") return false;
  if (c.web && (a.quoteOnly || a.priceOnRequest)) return false;
  return holdAvailable(a, c);
}

/**
 * Sellable at finalization for `$o`: AVAILABLE and free / ours / an expired foreign hold that is not
 * in flight. `is_published` is not required (a late payment for a free unpublished work is kept).
 */
export function isSellable(a: LockedArtwork, c: HoldContext): boolean {
  return a.saleStatus === "AVAILABLE" && holdAvailable(a, c);
}
