import "server-only";
import { eq } from "drizzle-orm";
import { nonLatinFields } from "@/lib/script";
import type { PostalAddress } from "@/lib/validation/address";
import { audit } from "@/server/audit";
import { type Db, db as defaultDb, type Tx } from "@/server/db/client";
import { type Order, orders } from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import type { Env } from "@/server/env";
import type {
  ShippingMethod,
  ShippingQuoteResult,
} from "@/server/shipping/types";
import { requoteOrder, shippingQuoteForOrder } from "./requote";
import {
  lockArtworks,
  lockOrder,
  orderArtworkIds,
  ordersWithAttemptInFlight,
} from "./reservations";

/**
 * The buyer side of a link order (spec §5.1 step 4 "Link orders with incomplete details show the
 * form"; §5.8). The admin created the order with the buyer's name, email and a locked price; the
 * buyer adds the delivery address, accepts the terms (18+, DAP abroad, receipt by email) and, when
 * the shipping is not locked by the painter, may pick another delivery method. A method change
 * runs `requoteOrder` (quote version bump: older PENDING attempts can no longer pay). Payment is
 * refused until the details are complete (`orderDetailsComplete`).
 */
export type LinkDetailsOrder = Pick<
  Order,
  | "shippingMethod"
  | "shipCountry"
  | "shipName"
  | "shipLine1"
  | "shipCity"
  | "termsAcceptedAt"
  | "ageConfirmedAt"
  | "dutiesAckAt"
>;

/** Everything the payment flow needs from the buyer is on the order (WEB orders always are). */
export function orderDetailsComplete(o: LinkDetailsOrder): boolean {
  if (!o.termsAcceptedAt || !o.ageConfirmedAt) return false;
  if (o.shipCountry !== "IL" && !o.dutiesAckAt) return false;
  if (o.shippingMethod === "LOCAL_PICKUP") return true;
  return Boolean(o.shipName && o.shipLine1 && o.shipCity);
}

export interface LinkDetailsInput {
  orderId: string;
  /** The delivery method the buyer picked (ignored unless it differs and shipping is not locked). */
  method?: ShippingMethod;
  shipTo: PostalAddress | null;
  buyer: { phone?: string; companyName?: string; vatId?: string };
  consents: {
    termsVersion: string;
    returnsVersion: string;
    privacyVersion: string;
    ageConfirmed: true;
    dutiesNoticeVersion?: string;
    receiptEmailConsent: boolean;
  };
  actor: string;
  ipHash: string | null;
}

export type LinkDetailsRefusal =
  | "not_found"
  | "not_link"
  | "not_payable"
  | "in_flight"
  | "method_locked"
  | "method_unavailable"
  | "address_required"
  | "latin_only"
  | "duties_ack_required";

export type LinkDetailsResult =
  | {
      kind: "saved";
      totalMinor: number;
      quoteVersion: number;
      totalChanged: boolean;
    }
  | { kind: "refused"; code: LinkDetailsRefusal };

class Refused extends Error {
  constructor(public readonly code: LinkDetailsRefusal) {
    super(code);
  }
}

export async function completeLinkOrderDetails(
  input: LinkDetailsInput,
  deps: { db?: Db; env?: Env } = {},
): Promise<ServiceResult<LinkDetailsResult>> {
  const db = deps.db ?? defaultDb;
  const [current] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!current) return withEffects({ kind: "refused", code: "not_found" });
  if (current.source === "WEB") {
    return withEffects({ kind: "refused", code: "not_link" });
  }
  const wanted = input.method ?? current.shippingMethod;
  let newQuote: ShippingQuoteResult | null = null;
  if (wanted !== current.shippingMethod) {
    if (current.shippingLocked) {
      return withEffects({ kind: "refused", code: "method_locked" });
    }
    try {
      newQuote = await shippingQuoteForOrder(
        current.id,
        { method: wanted },
        deps,
      );
    } catch {
      return withEffects({ kind: "refused", code: "method_unavailable" });
    }
    if (newQuote.mode !== "ok") {
      return withEffects({ kind: "refused", code: "method_unavailable" });
    }
  }
  const pickup = wanted === "LOCAL_PICKUP";
  const ship = pickup ? null : input.shipTo;
  if (!pickup && (!ship || ship.country !== current.shipCountry)) {
    return withEffects({ kind: "refused", code: "address_required" });
  }
  if (
    ship &&
    nonLatinFields(
      {
        name: ship.name,
        line1: ship.line1,
        line2: ship.line2,
        city: ship.city,
        region: ship.region,
        postalCode: ship.postalCode,
      },
      current.shipCountry,
    ).length > 0
  ) {
    return withEffects({ kind: "refused", code: "latin_only" });
  }
  if (current.shipCountry !== "IL" && !input.consents.dutiesNoticeVersion) {
    return withEffects({ kind: "refused", code: "duties_ack_required" });
  }

  try {
    const result = await withTx(
      (tx) => saveDetailsTx(tx, input, current, newQuote, ship),
      { db, name: "checkout.link_details" },
    );
    return withEffects(result, { revalidate: true });
  } catch (error) {
    if (error instanceof Refused) {
      return withEffects({ kind: "refused", code: error.code });
    }
    if (error instanceof ConflictError) {
      return withEffects({
        kind: "refused",
        code: error.code === "PAYMENT_IN_FLIGHT" ? "in_flight" : "not_payable",
      });
    }
    throw error;
  }
}

async function saveDetailsTx(
  tx: Tx,
  input: LinkDetailsInput,
  before: Order,
  newQuote: ShippingQuoteResult | null,
  ship: PostalAddress | null,
): Promise<LinkDetailsResult> {
  const now = new Date();
  if (before.status !== "AWAITING_PAYMENT") throw new Refused("not_payable");
  if (newQuote) {
    // Locks artworks → order, refuses while a payment is in flight, bumps the quote version.
    await requoteOrder(tx, before.id, newQuote, input.actor);
  } else {
    await lockArtworks(tx, await orderArtworkIds(tx, before.id));
  }
  const order = await lockOrder(tx, before.id);
  if (!order) throw new NotFoundError("order", before.id);
  if (order.status !== "AWAITING_PAYMENT") throw new Refused("not_payable");
  if ((await ordersWithAttemptInFlight(tx, [order.id])).size > 0) {
    throw new Refused("in_flight");
  }
  const c = input.consents;
  const [saved] = await tx
    .update(orders)
    .set({
      shipName: ship?.name ?? null,
      shipLine1: ship?.line1 ?? null,
      shipLine2: ship?.line2 ?? null,
      shipCity: ship?.city ?? null,
      shipRegion: ship?.region ?? null,
      shipPostalCode: ship?.postalCode ?? null,
      shipPhone: ship?.phone ?? null,
      ...(input.buyer.phone ? { buyerPhone: input.buyer.phone } : {}),
      ...(input.buyer.companyName
        ? { buyerCompanyName: input.buyer.companyName }
        : {}),
      ...(input.buyer.vatId ? { buyerVatId: input.buyer.vatId } : {}),
      termsVersion: c.termsVersion,
      returnsVersion: c.returnsVersion,
      privacyVersion: c.privacyVersion,
      termsAcceptedAt: now,
      ageConfirmedAt: now,
      dutiesNoticeVersion: c.dutiesNoticeVersion ?? null,
      dutiesAckAt: c.dutiesNoticeVersion ? now : null,
      receiptEmailConsent: c.receiptEmailConsent,
    })
    .where(eq(orders.id, order.id))
    .returning({
      totalMinor: orders.totalMinor,
      quoteVersion: orders.quoteVersion,
      shippingMethod: orders.shippingMethod,
    });
  if (!saved) throw new NotFoundError("order", order.id);
  await audit(
    {
      actor: input.actor,
      action: "order.link_details",
      entity: "order",
      entityId: order.id,
      before: {
        method: before.shippingMethod,
        totalMinor: before.totalMinor,
        quoteVersion: before.quoteVersion,
      },
      after: {
        method: saved.shippingMethod,
        totalMinor: saved.totalMinor,
        quoteVersion: saved.quoteVersion,
        receiptEmailConsent: c.receiptEmailConsent,
      },
      ipHash: input.ipHash,
    },
    tx,
  );
  return {
    kind: "saved",
    totalMinor: saved.totalMinor,
    quoteVersion: saved.quoteVersion,
    totalChanged: saved.totalMinor !== before.totalMinor,
  };
}
