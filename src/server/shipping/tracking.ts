import "server-only";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { type Db, db as defaultDb } from "@/server/db/client";
import {
  orders,
  type Shipment,
  shipmentEvents,
  shipments,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import {
  type ShipmentStatus,
  shipmentMachine,
} from "@/server/domain/state-machines";
import { env as defaultEnv, type Env } from "@/server/env";
import { forEachWithinBudget } from "@/server/jobs/index";
import { log } from "@/server/log";
import { carrierAdapter } from "./registry";
import { applyShipmentStatus, lockShipmentOf } from "./status";
import type {
  CarrierAdapter,
  CarrierCode,
  NormalizedTrackingEvent,
} from "./types";

/**
 * Tracking poll (spec §5.6), called by the hourly `tracking` job.
 *
 * - **Selection:** MOCK or DHL shipments with a waybill in LABEL_CREATED … OUT_FOR_DELIVERY or
 *   EXCEPTION whose `last_tracked_at` is null or older than 1 h, least recently tracked first.
 * - **Processing:** `track()` outside any transaction → in one transaction (order → shipment):
 *   insert every event (`ON CONFLICT DO NOTHING`, source POLL), then **advance monotonically**
 *   through the events in time order (`nextStatus`), each step through `applyShipmentStatus`
 *   (one email per new status; delivery bookkeeping). Unknown codes are recorded, never applied.
 * - A provider error only stamps `last_tracked_at` (retried next hour) and counts as failed.
 */
export const TRACKED_STATUSES = [
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "EXCEPTION",
] as const satisfies readonly ShipmentStatus[];

export const TRACKING_INTERVAL_MS = 60 * 60_000;

/** Progress along the carrier path; RETURNED and DELIVERED are both terminal. */
const RANK: Partial<Record<ShipmentStatus, number>> = {
  LABEL_CREATED: 0,
  PICKUP_SCHEDULED: 1,
  IN_TRANSIT: 2,
  CUSTOMS: 3,
  OUT_FOR_DELIVERY: 4,
  DELIVERED: 5,
  RETURNED: 5,
};

function edge(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return shipmentMachine.edges[from].includes(to);
}

/**
 * The status steps an event leads to from `current` (pure). Forward moves only, plus EXCEPTION
 * and its exits; after an exception, a later checkpoint goes back IN_TRANSIT first when the
 * machine has no direct edge (EXCEPTION → OUT_FOR_DELIVERY passes IN_TRANSIT).
 */
export function nextStatus(
  current: ShipmentStatus,
  reported: ShipmentStatus | null,
): ShipmentStatus[] {
  if (!reported || reported === current) return [];
  if (reported === "EXCEPTION")
    return edge(current, "EXCEPTION") ? ["EXCEPTION"] : [];
  if (current === "EXCEPTION") {
    if (edge(current, reported)) return [reported];
    const r = RANK[reported];
    if (
      r !== undefined &&
      r > (RANK.IN_TRANSIT as number) &&
      edge("IN_TRANSIT", reported)
    ) {
      return ["IN_TRANSIT", reported];
    }
    return [];
  }
  const from = RANK[current];
  const to = RANK[reported];
  if (from === undefined || to === undefined || to <= from) return [];
  return edge(current, reported) ? [reported] : [];
}

export interface PollOptions {
  limit: number;
  deadline: number;
  db?: Db;
  env?: Env;
  /** Injected in tests. */
  adapterFor?: (code: CarrierCode) => CarrierAdapter;
  now?: () => Date;
}

export async function pollTracking(opts: PollOptions): Promise<{
  checked: number;
  updated: number;
  failed?: number;
  skipped?: number;
}> {
  const db = opts.db ?? defaultDb;
  const env = opts.env ?? defaultEnv;
  const now = opts.now ?? (() => new Date());
  const adapterFor =
    opts.adapterFor ?? ((code: CarrierCode) => carrierAdapter(code, { env }));
  const staleBefore = new Date(now().getTime() - TRACKING_INTERVAL_MS);

  const due = await db
    .select()
    .from(shipments)
    .where(
      and(
        inArray(shipments.carrier, ["MOCK", "DHL"]),
        inArray(shipments.status, [...TRACKED_STATUSES]),
        isNotNull(shipments.trackingNumber),
        or(
          isNull(shipments.lastTrackedAt),
          lt(shipments.lastTrackedAt, staleBefore),
        ),
      ),
    )
    .orderBy(sql`${shipments.lastTrackedAt} ASC NULLS FIRST`, asc(shipments.id))
    .limit(opts.limit);

  let updated = 0;
  const stats = await forEachWithinBudget(
    { expired: () => Date.now() >= opts.deadline },
    due,
    async (s) => {
      const adapter = adapterFor(s.carrier as CarrierCode);
      if (!adapter.track) return;
      let events: NormalizedTrackingEvent[];
      try {
        ({ events } = await adapter.track(s.trackingNumber as string));
      } catch (error) {
        await db
          .update(shipments)
          .set({ lastTrackedAt: now() })
          .where(eq(shipments.id, s.id));
        throw error;
      }
      if (await applyTracking(db, s, events, now())) updated++;
    },
  );
  if (stats.failed > 0) log.warn("tracking.failed", { failed: stats.failed });
  return {
    checked: stats.processed + stats.failed,
    updated,
    failed: stats.failed,
    skipped: stats.skipped,
  };
}

/** Records the events and advances the status; true when the status changed. */
export async function applyTracking(
  db: Db,
  s: Pick<Shipment, "id" | "orderId">,
  events: readonly NormalizedTrackingEvent[],
  at: Date,
): Promise<boolean> {
  return withTx(
    async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, s.orderId))
        .for("update");
      let shipment = await lockShipmentOf(tx, s.orderId);
      if (!order || !shipment) return false;
      const sorted = [...events].sort((a, b) =>
        a.occurredAt.localeCompare(b.occurredAt),
      );
      if (sorted.length > 0) {
        await tx
          .insert(shipmentEvents)
          .values(
            sorted.map((e) => ({
              shipmentId: shipment?.id as string,
              occurredAt: new Date(e.occurredAt),
              status: e.status,
              code: e.code,
              description: e.description,
              location: e.location ?? null,
              source: "POLL" as const,
              raw: { code: e.code, description: e.description },
            })),
          )
          .onConflictDoNothing();
      }
      const start = shipment.status;
      if ((TRACKED_STATUSES as readonly string[]).includes(start)) {
        for (const e of sorted) {
          for (const to of nextStatus(shipment.status, e.status)) {
            shipment = await applyShipmentStatus(tx, {
              order,
              shipment,
              from: [shipment.status],
              to,
              actor: "system:tracking",
              source: "POLL",
              event: {
                occurredAt: new Date(e.occurredAt),
                code: e.code,
                description: e.description,
                location: e.location ?? null,
                raw: { code: e.code, description: e.description },
              },
            });
          }
        }
      }
      await tx
        .update(shipments)
        .set({ lastTrackedAt: at })
        .where(eq(shipments.id, shipment.id));
      return shipment.status !== start;
    },
    { db, name: "shipment.tracking" },
  );
}
