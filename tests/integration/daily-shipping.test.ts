import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import { paidShipmentOrder } from "../helpers/factories/shipping";

/**
 * M4 wiring of shipping (WS3) with the compliance jobs (WS6): the daily alerts for unshipped orders
 * past `dispatch_days + 2` and export declarations pending > 7 days, and the purge of raw carrier
 * tracking 30 days after delivery.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const { deadlineAlerts } = await import("@/server/jobs/daily");
const { runPurge } = await import("@/server/jobs/purge");

cleanDatabaseBeforeEach();

const DAY = 86_400_000;

async function alertsOf(kind: string) {
  return db
    .select()
    .from(schema.adminAlerts)
    .where(eq(schema.adminAlerts.kind, kind));
}

describe("daily shipping alerts", () => {
  it("an order unshipped beyond dispatch_days + 2 raises one WARNING; on time or blocked does not", async () => {
    const late = await paidShipmentOrder({ artwork: { dispatchDays: 3 } });
    const onTime = await paidShipmentOrder({ artwork: { dispatchDays: 3 } });
    const blocked = await paidShipmentOrder({ artwork: { dispatchDays: 3 } });
    await execSql(
      "UPDATE orders SET paid_at = now() - interval '6 days' WHERE id = ANY($1)",
      [[late.orderId, blocked.orderId]],
    );
    await execSql(
      "UPDATE orders SET paid_at = now() - interval '4 days' WHERE id = $1",
      [onTime.orderId],
    );
    await execSql(
      "UPDATE orders SET fulfillment_blocked_reason = 'DISPUTE' WHERE id = $1",
      [blocked.orderId],
    );
    const counts = await deadlineAlerts(db);
    expect(counts.unshippedLate).toBe(1);
    const alerts = await alertsOf("UNSHIPPED_LATE");
    expect(alerts.map((a) => a.entityId)).toEqual([late.orderId]);
    expect(alerts[0]?.severity).toBe("WARNING");
    // Deduplicated: the next day's run raises nothing new.
    expect((await deadlineAlerts(db)).unshippedLate).toBeUndefined();
  });

  it("an export declaration pending for more than 7 days raises a WARNING", async () => {
    const old = await paidShipmentOrder({ country: "US" });
    const fresh = await paidShipmentOrder({ country: "US" });
    await execSql(
      `UPDATE shipments SET export_decl_status = 'REQUIRED',
         created_at = now() - interval '8 days' WHERE id = $1`,
      [old.shipmentId],
    );
    await execSql(
      "UPDATE shipments SET export_decl_status = 'PENDING_CARRIER' WHERE id = $1",
      [fresh.shipmentId],
    );
    const counts = await deadlineAlerts(db);
    expect(counts.exportDeclaration).toBe(1);
    const alerts = await alertsOf("EXPORT_DECLARATION_PENDING");
    expect(alerts.map((a) => a.entityId)).toEqual([old.orderId]);
  });
});

describe("purge: raw carrier tracking", () => {
  it("clears shipment_events.raw 30 days after delivery and keeps recent deliveries", async () => {
    const old = await paidShipmentOrder({ country: "US" });
    const recent = await paidShipmentOrder({ country: "US" });
    const events = [
      [old.shipmentId, new Date(Date.now() - 40 * DAY)],
      [recent.shipmentId, new Date(Date.now() - 5 * DAY)],
    ] as const;
    for (const [shipmentId, at] of events) {
      await db.insert(schema.shipmentEvents).values({
        shipmentId,
        occurredAt: at,
        status: "DELIVERED",
        code: "OK",
        source: "POLL",
        raw: { typeCode: "OK", description: "Delivered" },
      });
      await db
        .update(schema.shipments)
        .set({ status: "DELIVERED", deliveredAt: at })
        .where(eq(schema.shipments.id, shipmentId));
    }
    const stats = await runPurge(db);
    expect(stats.trackingRaw).toBe(1);
    const rows = await db.select().from(schema.shipmentEvents);
    const rawOf = (id: string) =>
      rows.find((r) => r.shipmentId === id && r.code === "OK")?.raw;
    expect(rawOf(old.shipmentId)).toBeNull();
    expect(rawOf(recent.shipmentId)).toEqual({
      typeCode: "OK",
      description: "Delivered",
    });
  });
});
