import "server-only";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";

/**
 * Hold release and expiry (spec §3.5, §5.11 reconcile step 4; frozen contract). Both refuse orders
 * with an attempt in CAPTURING or PAYMENT_REVIEW. Bodies: M2.
 */
export async function releaseReservation(_input: {
  orderId: string;
  actor: string;
  reason: "RELEASED" | "ADMIN";
}): Promise<ServiceResult<{ released: boolean }>> {
  return notImplemented("releaseReservation", "M2");
}

/** AWAITING_PAYMENT orders past `expires_at` with no in-flight attempt → EXPIRED, holds released. */
export async function expireStaleOrders(_opts: {
  limit: number;
  deadline: number;
}): Promise<ServiceResult<{ expired: number }>> {
  return notImplemented("expireStaleOrders", "M2");
}
