import "server-only";
import { type SQL, sql } from "drizzle-orm";
import type { CommerceState } from "@/lib/catalog";
import { artworks } from "@/server/db/schema";

/**
 * Live commerce state (spec §2.4, §3.5 "Display"): read from the DB on every request, never
 * cached. The storefront shows it; checkout re-checks everything under row locks, so this is
 * display only and never decides state.
 *
 * - a live checkout hold by another buyer → `reserved` until `reserved_until` ("Reserved – on hold
 *   for another buyer until HH:MM", JSON-LD InStock). An expired hold whose order still has an
 *   attempt in CAPTURING / PAYMENT_REVIEW (the "in-flight foreign hold") also shows as reserved;
 * - ON_HOLD → `on_hold` ("Reserved" for RESERVED_OFFLINE, else "On hold"); SOLD; NOT_FOR_SALE;
 * - otherwise `available`, `buyable` when published, priced, not quote-only and not price on
 *   request (the WEB checkout preconditions of §3.5).
 */
export interface CommerceRow {
  saleStatus: "AVAILABLE" | "ON_HOLD" | "SOLD" | "NOT_FOR_SALE";
  holdReason: string | null;
  reservedByOrderId: string | null;
  reservedUntil: Date | null;
  isPublished: boolean;
  quoteOnly: boolean;
  priceOnRequest: boolean;
  priceIlsMinor: number | null;
  /** The in-flight foreign hold predicate (see `inFlightHoldSql`). */
  holdInFlight: boolean;
}

/** `EXISTS` an attempt in CAPTURING / PAYMENT_REVIEW for the order holding the artwork. */
export const inFlightHoldSql: SQL<boolean> = sql<boolean>`(${artworks.reservedByOrderId} IS NOT NULL AND EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = ${artworks.reservedByOrderId} AND pa.status IN ('CAPTURING', 'PAYMENT_REVIEW')))`;

/** The columns `commerceStateOf` needs, for `db.select({...commerceColumns})`. */
export const commerceColumns = {
  saleStatus: artworks.saleStatus,
  holdReason: artworks.holdReason,
  reservedByOrderId: artworks.reservedByOrderId,
  reservedUntil: artworks.reservedUntil,
  isPublished: artworks.isPublished,
  quoteOnly: artworks.quoteOnly,
  priceOnRequest: artworks.priceOnRequest,
  priceIlsMinor: artworks.priceIlsMinor,
  holdInFlight: inFlightHoldSql,
} as const;

export function commerceStateOf(r: CommerceRow, now: Date): CommerceState {
  switch (r.saleStatus) {
    case "SOLD":
      return { kind: "sold" };
    case "NOT_FOR_SALE":
      return { kind: "not_for_sale" };
    case "ON_HOLD":
      return {
        kind: "on_hold",
        reservedOffline: r.holdReason === "RESERVED_OFFLINE",
      };
    case "AVAILABLE":
      break;
  }
  if (r.reservedByOrderId !== null && r.reservedUntil !== null) {
    const live = r.reservedUntil.getTime() > now.getTime();
    if (live || r.holdInFlight) {
      const until = live ? r.reservedUntil : now;
      return { kind: "reserved", until: until.toISOString() };
    }
  }
  return {
    kind: "available",
    buyable:
      r.isPublished &&
      r.priceIlsMinor !== null &&
      !r.quoteOnly &&
      !r.priceOnRequest,
  };
}
