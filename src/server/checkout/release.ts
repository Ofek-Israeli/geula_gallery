import "server-only";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { audit } from "@/server/audit";
import { type Db, db as defaultDb } from "@/server/db/client";
import { artworks, orders } from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { transition } from "@/server/domain/transition";
import { settleLinkRequests } from "./link-requests";
import {
  lockArtworks,
  lockOrder,
  orderArtworkIds,
  ordersWithAttemptInFlight,
  releaseHoldsOf,
} from "./reservations";

/**
 * Hold release and expiry (spec §3.5, §5.11 reconcile step 4; frozen contract). Both refuse orders
 * with an attempt in CAPTURING or PAYMENT_REVIEW (a payment is being confirmed). Lock order:
 * the order's artworks → the order.
 */
export interface ReleaseDeps {
  db?: Db;
}

/** "Release my hold" (buyer, `RELEASED`) or the admin (`ADMIN`): AWAITING_PAYMENT → EXPIRED. */
export async function releaseReservation(
  input: {
    orderId: string;
    actor: string;
    reason: "RELEASED" | "ADMIN";
  },
  deps: ReleaseDeps = {},
): Promise<ServiceResult<{ released: boolean }>> {
  const released = await withTx(
    async (tx) => {
      const artworkIds = await orderArtworkIds(tx, input.orderId);
      await lockArtworks(tx, artworkIds);
      const order = await lockOrder(tx, input.orderId);
      if (!order) throw new NotFoundError("order", input.orderId);
      if ((await ordersWithAttemptInFlight(tx, [order.id])).size > 0) {
        throw new ConflictError(
          "PAYMENT_IN_FLIGHT",
          "a payment is being confirmed",
        );
      }
      if (order.status !== "AWAITING_PAYMENT") return false;
      await releaseHoldsOf(tx, order.id);
      await transition(
        tx,
        "order",
        order.id,
        ["AWAITING_PAYMENT"],
        "EXPIRED",
        { statusReason: input.reason, expiresAt: new Date() },
        input.actor,
        { action: "order.hold_released" },
      );
      await settleLinkRequests(tx, [order.id], "EXPIRED", input.actor);
      return true;
    },
    { db: deps.db, name: "checkout.release" },
  );
  return withEffects({ released }, released ? { revalidate: true } : {});
}

/**
 * AWAITING_PAYMENT orders past `expires_at` with no in-flight attempt → EXPIRED (`HOLD_EXPIRED`,
 * link orders `LINK_EXPIRED`), holds released (artworks first). Each order is its own short
 * transaction; the conditions are re-checked under the locks. Stops at `deadline`.
 */
export async function expireStaleOrders(
  opts: { limit: number; deadline: number },
  deps: ReleaseDeps = {},
): Promise<ServiceResult<{ expired: number }>> {
  const db = deps.db ?? defaultDb;
  const candidates = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "AWAITING_PAYMENT"),
        lt(orders.expiresAt, sql`now()`),
        sql`NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = ${orders.id} AND pa.status IN ('CAPTURING', 'PAYMENT_REVIEW'))`,
      ),
    )
    .orderBy(asc(orders.expiresAt))
    .limit(opts.limit);

  let expired = 0;
  for (const c of candidates) {
    if (Date.now() > opts.deadline) break;
    const done = await withTx(
      async (tx) => {
        const artworkIds = await orderArtworkIds(tx, c.id);
        await lockArtworks(tx, artworkIds);
        const order = await lockOrder(tx, c.id);
        if (
          order?.status !== "AWAITING_PAYMENT" ||
          !order.expiresAt ||
          order.expiresAt.getTime() > Date.now() ||
          (await ordersWithAttemptInFlight(tx, [order.id])).size > 0
        ) {
          return false;
        }
        await releaseHoldsOf(tx, order.id);
        await transition(
          tx,
          "order",
          order.id,
          ["AWAITING_PAYMENT"],
          "EXPIRED",
          {
            statusReason:
              order.source === "WEB" ? "HOLD_EXPIRED" : "LINK_EXPIRED",
          },
          "system",
          { action: "order.hold_expired" },
        );
        // Link requests → EXPIRED with their order (spec §5.11 reconcile step 4).
        await settleLinkRequests(tx, [order.id], "EXPIRED", "system");
        return true;
      },
      { db, name: "checkout.expire" },
    );
    if (done) expired += 1;
  }
  if (expired > 0) {
    await audit(
      {
        actor: "system",
        action: "orders.expired_batch",
        entity: "order",
        after: { expired },
      },
      db,
    );
  }
  return withEffects({ expired }, expired > 0 ? { revalidate: true } : {});
}

/** Order statuses whose remaining holds are orphans (the order can never pay with them). */
const DEAD_HOLDER_STATUSES = ["EXPIRED", "CANCELLED"] as const;

/**
 * Releases the holds still pointing at dead orders (EXPIRED / CANCELLED, no attempt in flight).
 * A takeover expires the previous holder of one work, but that order's *other* works kept its
 * hold (a cart is one order with several works). Harmless to correctness (an expired hold is free
 * to anyone), but stale. One short transaction per order: the order's held artworks → the order.
 */
export async function releaseOrphanedHolds(
  orderIds: readonly string[],
  deps: ReleaseDeps = {},
): Promise<{ released: number }> {
  const db = deps.db ?? defaultDb;
  let released = 0;
  for (const orderId of [...new Set(orderIds)].sort()) {
    released += await withTx(
      async (tx) => {
        const held = await tx
          .select({ id: artworks.id })
          .from(artworks)
          .where(eq(artworks.reservedByOrderId, orderId));
        if (held.length === 0) return 0;
        await lockArtworks(
          tx,
          held.map((h) => h.id),
        );
        const order = await lockOrder(tx, orderId);
        if (
          !order ||
          !(DEAD_HOLDER_STATUSES as readonly string[]).includes(order.status)
        ) {
          return 0;
        }
        if ((await ordersWithAttemptInFlight(tx, [order.id])).size > 0) {
          return 0;
        }
        return releaseHoldsOf(tx, order.id);
      },
      { db, name: "checkout.release_orphans" },
    );
  }
  return { released };
}

/** Reconcile safety net: finds dead orders that still hold works and releases them. */
export async function sweepOrphanedHolds(
  opts: { limit: number },
  deps: ReleaseDeps = {},
): Promise<{ released: number }> {
  const db = deps.db ?? defaultDb;
  const rows = await db
    .selectDistinct({ orderId: orders.id })
    .from(artworks)
    .innerJoin(orders, eq(orders.id, artworks.reservedByOrderId))
    .where(inArray(orders.status, [...DEAD_HOLDER_STATUSES]))
    .limit(opts.limit);
  return releaseOrphanedHolds(
    rows.map((r) => r.orderId),
    deps,
  );
}
