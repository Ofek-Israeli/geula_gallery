import "server-only";
import { eq } from "drizzle-orm";
import { cancellationWindow } from "@/lib/deadlines";
import { addJerusalemDays } from "@/lib/format";
import type { Tx } from "@/server/db/client";
import {
  type Order,
  orders,
  type Shipment,
  shipmentEvents,
  shipments,
} from "@/server/db/schema";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import { type TransitionPatch, transition } from "@/server/domain/transition";
import { log } from "@/server/log";
import { enqueueEmail } from "@/server/outbox/enqueue";

/**
 * One shipment status change (spec §5.5 step 4), used by every fulfillment action and by the
 * tracking job. In the caller's transaction, with the order and the shipment already locked
 * (order → shipment):
 * - the conditional transition (`transition()`, audited);
 * - a `shipment_events` row (dedupe `(shipment, source, occurred_at, code)`);
 * - the buyer email: `shipment-update` (`email:shipment-update:<id>:<status>`, so one email per
 *   status ever), or `ready-for-pickup` (it reveals the pickup address);
 * - on DELIVERED / COLLECTED: `orders.delivered_at`, `orders.cancellation_window_ends_at` and
 *   `shipments.insurance_claim_deadline_at` (+30 days).
 */

/** Statuses the buyer is told about. Internal steps (packing, the label claim) are silent. */
export const BUYER_NOTIFIED: ReadonlySet<ShipmentStatus> = new Set([
  "LABEL_CREATED",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "RETURNED",
  "COLLECTED",
]);

export const DELIVERED_STATES: ReadonlySet<ShipmentStatus> = new Set([
  "DELIVERED",
  "COLLECTED",
]);

/** Days after delivery during which an insurance claim can be filed (spec §5.5). */
export const INSURANCE_CLAIM_DAYS = 30;

export interface StatusChange {
  order: Order;
  shipment: Shipment;
  from: readonly ShipmentStatus[];
  to: ShipmentStatus;
  actor: string;
  ipHash?: string | null;
  source: "MANUAL" | "POLL" | "WEBHOOK" | "SYSTEM";
  patch?: TransitionPatch<"shipment">;
  event?: {
    occurredAt?: Date;
    code?: string;
    description?: string | null;
    location?: string | null;
    raw?: unknown;
  };
  /** Audit verb; default `shipment.<to>`. */
  action?: string;
}

/**
 * The cancellation window that starts at delivery (spec §5.7 step 6). `deadlines.ts` is WS6's;
 * until its body lands it throws, and the window is left for the daily job to fill.
 */
export function windowEndAfterDelivery(
  order: Pick<Order, "disclosureSentAt" | "conversationTookPlace">,
  deliveredAt: Date,
): Date | null {
  try {
    return cancellationWindow({
      deliveredAt,
      disclosureSentAt: order.disclosureSentAt,
      eligibleGroup: "NONE",
      conversationTookPlace: order.conversationTookPlace ?? false,
    }).end;
  } catch (error) {
    log.warn("shipping.cancellation_window_unavailable", {}, error);
    return null;
  }
}

export async function applyShipmentStatus(
  tx: Tx,
  c: StatusChange,
): Promise<Shipment> {
  const occurredAt = c.event?.occurredAt ?? new Date();
  const delivered = DELIVERED_STATES.has(c.to);
  const patch: TransitionPatch<"shipment"> = { ...(c.patch ?? {}) };
  if (delivered) {
    patch.deliveredAt = occurredAt;
    patch.insuranceClaimDeadlineAt = addJerusalemDays(
      occurredAt,
      INSURANCE_CLAIM_DAYS,
    );
  }
  if (c.to === "IN_TRANSIT" && !c.shipment.shippedAt && !patch.shippedAt) {
    patch.shippedAt = occurredAt;
  }
  const row = await transition(
    tx,
    "shipment",
    c.shipment.id,
    c.from,
    c.to,
    patch,
    c.actor,
    {
      ipHash: c.ipHash ?? null,
      action: c.action ?? `shipment.${c.to.toLowerCase()}`,
    },
  );
  await tx
    .insert(shipmentEvents)
    .values({
      shipmentId: c.shipment.id,
      occurredAt,
      status: c.to,
      code: c.event?.code ?? `${c.source}_${c.to}`,
      description: c.event?.description ?? null,
      location: c.event?.location ?? null,
      source: c.source,
      raw: c.event?.raw ?? null,
    })
    .onConflictDoNothing();

  if (delivered && !c.order.deliveredAt) {
    await tx
      .update(orders)
      .set({
        deliveredAt: occurredAt,
        cancellationWindowEndsAt: windowEndAfterDelivery(c.order, occurredAt),
      })
      .where(eq(orders.id, c.order.id));
  }

  const to = c.order.buyerEmail;
  if (to && c.to === "READY_FOR_PICKUP") {
    await enqueueEmail(tx, {
      template: "ready-for-pickup",
      to,
      locale: c.order.locale,
      refId: c.shipment.id,
    });
  } else if (to && BUYER_NOTIFIED.has(c.to)) {
    await enqueueEmail(tx, {
      template: "shipment-update",
      to,
      locale: c.order.locale,
      refId: `${c.shipment.id}:${c.to}`,
    });
  }
  return row;
}

/** Re-reads the shipment of a locked order (`FOR UPDATE`). */
export async function lockShipmentOf(
  tx: Tx,
  orderId: string,
): Promise<Shipment | undefined> {
  const [row] = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId))
    .for("update");
  return row;
}
