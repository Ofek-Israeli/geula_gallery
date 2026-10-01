import "server-only";
import { and, inArray } from "drizzle-orm";
import type { Tx } from "@/server/db/client";
import { buyerRequests } from "@/server/db/schema";
import {
  canRequestTransition,
  type RequestStatus,
} from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";

/** Request statuses that still point at a live link order (spec §5.8). */
export const LINKED_REQUEST_STATUSES = [
  "QUOTED",
  "ACCEPTED",
  "COUNTERED",
] as const satisfies readonly RequestStatus[];

/**
 * Moves the request(s) behind link orders on (spec §5.8): PAID → CONVERTED; expired, released,
 * taken over or lost → EXPIRED. Runs in the caller's transaction after the order rows are locked
 * (lock order: … → orders → buyer_requests). A no-op for WEB orders and for requests that already
 * moved on.
 */
export async function settleLinkRequests(
  tx: Tx,
  orderIds: readonly string[],
  to: "CONVERTED" | "EXPIRED",
  actor: string,
): Promise<number> {
  if (orderIds.length === 0) return 0;
  const rows = await tx
    .select({
      id: buyerRequests.id,
      kind: buyerRequests.kind,
      status: buyerRequests.status,
    })
    .from(buyerRequests)
    .where(
      and(
        inArray(buyerRequests.orderId, [...orderIds]),
        inArray(buyerRequests.status, [...LINKED_REQUEST_STATUSES]),
      ),
    )
    .orderBy(buyerRequests.id)
    .for("update");
  let moved = 0;
  for (const r of rows) {
    if (!canRequestTransition(r.kind, r.status, to)) continue;
    await transition(tx, "buyerRequest", r.id, [r.status], to, {}, actor, {
      action: `request.${to.toLowerCase()}`,
    });
    moved += 1;
  }
  return moved;
}
