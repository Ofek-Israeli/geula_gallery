import "server-only";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";
import type { ShipmentStatus } from "@/server/domain/state-machines";

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
