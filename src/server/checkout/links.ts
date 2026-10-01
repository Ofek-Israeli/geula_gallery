import "server-only";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";
import type { ShippingMethod } from "@/server/shipping/types";
import type { BuyerDetails } from "./types";

/** `createLinkOrder()` (spec §5.8; frozen contract). Body: WS2 (manual and quote) / WS4 (UI). */
export interface CreateLinkOrderInput {
  kind: "QUOTE" | "OFFER" | "MANUAL";
  artworkId: string;
  buyer: BuyerDetails;
  country: string;
  currency: Currency;
  itemPriceMinor: number;
  lockedShippingMinor?: number;
  shippingMethod?: ShippingMethod;
  conversationTookPlace: boolean;
  expiresInHours?: number;
  locale: Locale;
  /** The inbox request this link answers (moves to QUOTED / ACCEPTED / COUNTERED). */
  requestId?: string;
  /** Required when the price differs from the list price (spec §5.10). */
  priceChangeReason?: string;
}

export async function createLinkOrder(
  _input: CreateLinkOrderInput,
  _ctx: AdminContext,
): Promise<
  ServiceResult<{ orderId: string; orderNumber: string; linkUrl: string }>
> {
  return notImplemented("createLinkOrder", "WS2");
}
