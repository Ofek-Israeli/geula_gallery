import "server-only";
import { eq, inArray } from "drizzle-orm";
import { audit } from "@/server/audit";
import { type DbOrTx, db as defaultDb, type Tx } from "@/server/db/client";
import { artworks, orders } from "@/server/db/schema";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/server/domain/errors";
import { env as defaultEnv, type Env } from "@/server/env";
import { getSetting } from "@/server/settings";
import { carrierFor } from "@/server/shipping/registry";
import type {
  ShippingMethod,
  ShippingQuoteResult,
} from "@/server/shipping/types";
import { orderAmounts, shippingOptions } from "./pricing";
import {
  lockArtworks,
  lockOrder,
  orderArtworkIds,
  ordersWithAttemptInFlight,
} from "./reservations";

/**
 * `requoteOrder()` (spec §5.1 step 4; frozen contract): locks artworks → order, refuses while an
 * attempt is in flight, updates the amounts and bumps `quote_version` on any change to amounts,
 * method or address-dependent shipping. Older PENDING attempts stay open at the provider but can
 * no longer pay the order (quote binding, spec §5.2 step 5).
 *
 * Items are immutable and priced in the order currency, so a currency change is refused here
 * (M2 decision): the buyer gets a new order instead.
 */
export async function requoteOrder(
  tx: Tx,
  orderId: string,
  newQuote: ShippingQuoteResult,
  actor = "system",
): Promise<{ quoteVersion: number; totalMinor: number; changed: boolean }> {
  const artworkIds = await orderArtworkIds(tx, orderId);
  await lockArtworks(tx, artworkIds);
  const order = await lockOrder(tx, orderId);
  if (!order) throw new NotFoundError("order", orderId);
  if (!["AWAITING_PAYMENT", "EXPIRED"].includes(order.status)) {
    throw new ConflictError("NOT_REQUOTABLE", "the order is no longer open");
  }
  if ((await ordersWithAttemptInFlight(tx, [order.id])).size > 0) {
    throw new ConflictError(
      "PAYMENT_IN_FLIGHT",
      "a payment is being confirmed",
    );
  }
  if (newQuote.mode !== "ok") {
    throw new ValidationError("QUOTE_NOT_OK", "the new quote is not payable");
  }
  if (newQuote.currency !== order.currency) {
    throw new ValidationError(
      "CURRENCY_CHANGE",
      "a currency change needs a new order",
    );
  }
  const amounts = orderAmounts({
    itemsTotalMinor: order.itemsTotalMinor,
    quote: newQuote,
    vatMode: order.vatMode,
    country: order.shipCountry,
    date: new Date(),
  });
  const changed =
    amounts.shippingMinor !== order.shippingMinor ||
    amounts.insuranceMinor !== order.insuranceMinor ||
    amounts.totalMinor !== order.totalMinor ||
    newQuote.method !== order.shippingMethod ||
    JSON.stringify(newQuote) !== JSON.stringify(order.shippingQuote);
  if (!changed) {
    return {
      quoteVersion: order.quoteVersion,
      totalMinor: order.totalMinor,
      changed: false,
    };
  }
  const [updated] = await tx
    .update(orders)
    .set({
      shippingMinor: amounts.shippingMinor,
      insuranceMinor: amounts.insuranceMinor,
      totalMinor: amounts.totalMinor,
      vatRateBp: amounts.vatRateBp,
      vatMinor: amounts.vatMinor,
      shippingMethod: newQuote.method,
      shippingQuote: newQuote,
      quoteVersion: order.quoteVersion + 1,
    })
    .where(eq(orders.id, order.id))
    .returning({
      quoteVersion: orders.quoteVersion,
      totalMinor: orders.totalMinor,
    });
  if (!updated) throw new NotFoundError("order", orderId);
  await audit(
    {
      actor,
      action: "order.requoted",
      entity: "order",
      entityId: order.id,
      before: {
        quoteVersion: order.quoteVersion,
        totalMinor: order.totalMinor,
        method: order.shippingMethod,
      },
      after: { ...updated, method: newQuote.method },
    },
    tx,
  );
  return { ...updated, changed: true };
}

/** Every candidate method's quote for an existing order's works, priced like checkout. */
export async function shippingChoicesForOrder(
  orderId: string,
  i: { country?: string } = {},
  deps: { db?: DbOrTx; env?: Env; now?: Date } = {},
): Promise<ShippingQuoteResult[]> {
  const db = deps.db ?? defaultDb;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order", orderId);
  const ids = await orderArtworkIds(db, orderId);
  const items = await db
    .select()
    .from(artworks)
    .where(inArray(artworks.id, ids));
  const country = i.country ?? order.shipCountry;
  return shippingOptions({
    items,
    country,
    currency: order.currency,
    date: deps.now ?? new Date(),
    shipping: await getSetting("shipping", db),
    checkout: await getSetting("checkout", db),
    carrier: carrierFor(country, { env: deps.env ?? defaultEnv }),
  }).all;
}

/**
 * The shipping quote of an existing order's works for `method` (and optionally a new
 * destination), priced like checkout. Holds are irrelevant here: the order's own hold is not a
 * reason to refuse its requote. Returns the engine result (check `mode`).
 */
export async function shippingQuoteForOrder(
  orderId: string,
  i: { method: ShippingMethod; country?: string },
  deps: { db?: DbOrTx; env?: Env; now?: Date } = {},
): Promise<ShippingQuoteResult> {
  const all = await shippingChoicesForOrder(
    orderId,
    i.country ? { country: i.country } : {},
    deps,
  );
  const quote = all.find((q) => q.method === i.method);
  if (!quote) {
    throw new ValidationError("METHOD_UNAVAILABLE", "method not offered here");
  }
  return quote;
}
