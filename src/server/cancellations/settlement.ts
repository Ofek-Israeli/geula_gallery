import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/server/db/client";
import {
  cancellationItems,
  cancellations,
  orderItems,
  orders,
  refunds,
} from "@/server/db/schema";
import { transition } from "@/server/domain/transition";

/**
 * When an order with per-work cancellations becomes CANCELLED (spec §5.7 step 8, per work): only
 * once **every** work of the order is covered by an accepted cancellation and each of those
 * cancellations' refunds settled (SUCCEEDED / MANUAL_DONE) or was 0. Until then the order stays
 * PAID / COMPLETED and its remaining works ship. Called with the order row locked (refund
 * settlement, acceptance); idempotent.
 */
export async function cancelOrderIfFullyCancelled(
  tx: Tx,
  orderId: string,
  actor = "system",
  now: Date = new Date(),
): Promise<boolean> {
  const [order] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order || (order.status !== "PAID" && order.status !== "COMPLETED")) {
    return false;
  }
  const [uncovered] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .leftJoin(
      cancellationItems,
      eq(cancellationItems.orderItemId, orderItems.id),
    )
    .where(
      and(
        eq(orderItems.orderId, orderId),
        isNull(cancellationItems.orderItemId),
      ),
    )
    .limit(1);
  if (uncovered) return false;
  const [anyItem] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .limit(1);
  if (!anyItem) return false;

  // Every cancellation that covers a work: its refund settled, or nothing was to be refunded.
  const covering = await tx
    .select({
      id: cancellations.id,
      refundId: cancellations.refundId,
      refundAmountMinor: cancellations.refundAmountMinor,
      refundStatus: refunds.status,
    })
    .from(cancellations)
    .leftJoin(refunds, eq(refunds.id, cancellations.refundId))
    .where(
      and(
        eq(cancellations.orderId, orderId),
        inArray(
          cancellations.id,
          tx
            .select({ id: cancellationItems.cancellationId })
            .from(cancellationItems)
            .where(eq(cancellationItems.orderId, orderId)),
        ),
      ),
    );
  const settled = covering.every((c) =>
    c.refundId
      ? c.refundStatus === "SUCCEEDED" || c.refundStatus === "MANUAL_DONE"
      : (c.refundAmountMinor ?? 0) === 0,
  );
  if (!settled) return false;
  await transition(
    tx,
    "order",
    orderId,
    ["PAID", "COMPLETED"],
    "CANCELLED",
    { statusReason: "BUYER_CANCELLATION", cancelledAt: now },
    actor,
  );
  return true;
}
