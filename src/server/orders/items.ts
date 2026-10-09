import "server-only";
import { asc, eq } from "drizzle-orm";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  cancellationItems,
  cancellations,
  type OrderItem,
  orderItems,
} from "@/server/db/schema";

/**
 * The works of an order and which of them were cancelled (per-work cancellation). `order_items`
 * rows never change; a work is cancelled once a `cancellation_items` row names it (written when a
 * notice is accepted, never removed). Active = not cancelled: what still ships, is declared on the
 * customs papers and is listed on the packing slip.
 */
export interface OrderItemState extends OrderItem {
  cancellation: {
    id: string;
    number: string;
    returnStatus: (typeof cancellationItems.$inferSelect)["returnStatus"];
  } | null;
}

/** Every item of the order (creation order) with the cancellation that covers it, if any. */
export async function orderItemsWithState(
  db: DbOrTx,
  orderId: string,
): Promise<OrderItemState[]> {
  const rows = await db
    .select({
      item: orderItems,
      cancellationId: cancellationItems.cancellationId,
      number: cancellations.number,
      returnStatus: cancellationItems.returnStatus,
    })
    .from(orderItems)
    .leftJoin(
      cancellationItems,
      eq(cancellationItems.orderItemId, orderItems.id),
    )
    .leftJoin(
      cancellations,
      eq(cancellations.id, cancellationItems.cancellationId),
    )
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  return rows.map((r) => ({
    ...r.item,
    cancellation:
      r.cancellationId && r.number && r.returnStatus
        ? {
            id: r.cancellationId,
            number: r.number,
            returnStatus: r.returnStatus,
          }
        : null,
  }));
}

/** The items still active (not cancelled), in creation order. */
export async function activeOrderItems(
  db: DbOrTx = defaultDb,
  orderId: string,
): Promise<OrderItem[]> {
  const all = await orderItemsWithState(db, orderId);
  return all.filter((i) => i.cancellation === null).map(stripState);
}

/** The items a given cancellation covers. */
export async function itemsOfCancellation(
  db: DbOrTx,
  cancellationId: string,
): Promise<OrderItemState[]> {
  const [head] = await db
    .select({ orderId: cancellations.orderId })
    .from(cancellations)
    .where(eq(cancellations.id, cancellationId));
  if (!head?.orderId) return [];
  const all = await orderItemsWithState(db, head.orderId);
  return all.filter((i) => i.cancellation?.id === cancellationId);
}

function stripState({ cancellation: _, ...item }: OrderItemState): OrderItem {
  return item;
}
