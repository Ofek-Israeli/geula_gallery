import "server-only";
import { eq } from "drizzle-orm";
import { audit, auditBy } from "@/server/audit";
import type { Db } from "@/server/db/client";
import { orders, shipmentEvents, shipments } from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  notImplemented,
  ValidationError,
} from "@/server/domain/errors";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { enqueueEmail } from "@/server/outbox/enqueue";

/**
 * Fulfillment services (spec §5.5). Frozen entry points; bodies: WS3. The label claim protocol:
 * PACKED → LABEL_REQUESTED (commit) → carrier call → LABEL_CREATED / PACKED (clear refusal) /
 * LABEL_UNKNOWN (timeout; admin confirms before retrying).
 */
export async function createShipmentForOrder(
  _orderId: string,
  _ctx: AdminContext,
): Promise<ServiceResult<{ shipmentId: string }>> {
  return notImplemented("createShipmentForOrder", "WS3");
}

export async function requestLabel(
  _shipmentId: string,
  _ctx: AdminContext,
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  return notImplemented("requestLabel", "WS3");
}

// ---------------------------------------------------------------- manual tracking (M2 minimal)

export interface ManualTrackingInput {
  carrierName: string;
  trackingNumber: string;
  trackingUrl?: string | null;
  /** The parcel was handed to the carrier: LABEL_CREATED → IN_TRANSIT. */
  handedOver?: boolean;
}

const MANUAL_TRACKING_FROM = [
  "AWAITING_FULFILLMENT",
  "PACKED",
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
] as const satisfies readonly ShipmentStatus[];

/**
 * Manual tracking entry (spec §5.5 step 3a, minimal M2 version): records the carrier name and
 * tracking number of a parcel sent outside the integrated carriers and moves the shipment to
 * LABEL_CREATED (via PACKED; the packing checklist itself is WS3's fulfillment screen), then to
 * IN_TRANSIT when the parcel was handed over. A shipment already past LABEL_CREATED only gets its
 * tracking details corrected.
 *
 * Guards: the order is PAID and not blocked (`fulfillment_blocked_reason`, which includes a pending
 * cancellation notice); only carrier methods have tracking. Lock order: order → shipment. Every
 * status change inserts a MANUAL `shipment_events` row and enqueues `shipment-update`
 * (`email:shipment-update:<shipmentId>:<status>`), except PACKED, which buyers are not told about.
 */
export async function recordManualTracking(
  orderId: string,
  input: ManualTrackingInput,
  ctx: AdminContext,
  deps: { db?: Db } = {},
): Promise<ServiceResult<{ status: ShipmentStatus }>> {
  const carrierName = input.carrierName.trim();
  const trackingNumber = input.trackingNumber.trim();
  if (!carrierName || !trackingNumber) {
    throw new ValidationError(
      "TRACKING_REQUIRED",
      "carrier name and tracking number are required",
    );
  }
  try {
    const status = await withTx(
      async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .for("update");
        if (!order) throw new NotFoundError("order", orderId);
        if (order.status !== "PAID") {
          throw new ConflictError("ORDER_NOT_PAID", "the order is not paid");
        }
        if (order.fulfillmentBlockedReason) {
          throw new ConflictError(
            "FULFILLMENT_BLOCKED",
            `fulfillment is blocked: ${order.fulfillmentBlockedReason}`,
          );
        }
        const [shipment] = await tx
          .select()
          .from(shipments)
          .where(eq(shipments.orderId, order.id))
          .for("update");
        if (!shipment) throw new NotFoundError("shipment", order.id);
        if (
          shipment.method !== "CARRIER_TABLE" &&
          shipment.method !== "QUOTED"
        ) {
          throw new ConflictError(
            "NOT_A_CARRIER_SHIPMENT",
            "pickup and artist delivery have no tracking",
          );
        }
        if (
          !(MANUAL_TRACKING_FROM as readonly string[]).includes(shipment.status)
        ) {
          throw new ConflictError(
            "SHIPMENT_STATE",
            `cannot record tracking in ${shipment.status}`,
          );
        }
        const details = {
          carrier: "MANUAL" as const,
          carrierName,
          trackingNumber,
          trackingUrl: input.trackingUrl?.trim() || null,
        };
        const steps: ShipmentStatus[] = [];
        let current: ShipmentStatus = shipment.status;
        if (current === "AWAITING_FULFILLMENT") steps.push("PACKED");
        if (current === "AWAITING_FULFILLMENT" || current === "PACKED") {
          steps.push("LABEL_CREATED");
        }
        if (input.handedOver) steps.push("IN_TRANSIT");
        if (steps.length === 0) {
          await tx
            .update(shipments)
            .set(details)
            .where(eq(shipments.id, shipment.id));
          await audit(
            {
              ...auditBy(ctx),
              action: "shipment.tracking_corrected",
              entity: "shipment",
              entityId: shipment.id,
              after: { carrierName, trackingNumber },
            },
            tx,
          );
          return current;
        }
        const now = new Date();
        for (const to of steps) {
          await transition(
            tx,
            "shipment",
            shipment.id,
            [current],
            to,
            {
              ...details,
              ...(to === "IN_TRANSIT" ? { shippedAt: now } : {}),
            },
            ctx.actor,
            { ipHash: ctx.ipHash, action: `shipment.${to.toLowerCase()}` },
          );
          await tx
            .insert(shipmentEvents)
            .values({
              shipmentId: shipment.id,
              occurredAt: now,
              status: to,
              code: `MANUAL_${to}`,
              description: to === "LABEL_CREATED" ? carrierName : null,
              source: "MANUAL",
            })
            .onConflictDoNothing();
          if (to !== "PACKED" && order.buyerEmail) {
            await enqueueEmail(tx, {
              template: "shipment-update",
              to: order.buyerEmail,
              locale: order.locale,
              refId: `${shipment.id}:${to}`,
            });
          }
          current = to;
        }
        return current;
      },
      { db: deps.db, name: "shipment.manual_tracking" },
    );
    return withEffects({ status }, { outbox: true, revalidate: true });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "TRACKING_NUMBER_IN_USE",
        "this tracking number is already recorded for another shipment",
      );
    }
    throw error;
  }
}
