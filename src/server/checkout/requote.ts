import "server-only";
import type { Tx } from "@/server/db/client";
import { notImplemented } from "@/server/domain/errors";
import type { ShippingQuoteResult } from "@/server/shipping/types";

/**
 * `requoteOrder()` (spec §5.1 step 4; frozen contract): locks artworks → order, refuses while an
 * attempt is in flight, updates the amounts and bumps `quote_version` on any change to items,
 * amounts, currency, method or address-dependent shipping. Body: M2.
 */
export async function requoteOrder(
  _tx: Tx,
  _orderId: string,
  _newQuote: ShippingQuoteResult,
): Promise<{ quoteVersion: number; totalMinor: number; changed: boolean }> {
  return notImplemented("requoteOrder", "M2");
}
