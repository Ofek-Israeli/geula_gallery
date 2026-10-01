import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";

/**
 * Admin order services (spec §6.10): list and detail reads, "Recheck payment" through the one
 * `finalizeAttempt()`, and the minimal manual tracking entry with its guards.
 */
const { db } = await import("@/server/db/client");
const { auditLog, orders, outboxJobs, shipmentEvents, shipments } =
  await import("@/server/db/schema");
const { listAdminOrders, getAdminOrder, recheckPayment } = await import(
  "@/server/orders/admin"
);
const { recordManualTracking } = await import("@/server/shipping/shipments");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
type AdminContext = import("@/server/domain/admin").AdminContext;

const ctx = {
  userId: "u-admin",
  email: "admin@example.test",
  name: "Admin",
  sessionId: "s1",
  sessionCreatedAt: new Date(),
  twoFactorEnabled: true,
  locale: "he",
  ipHash: null,
  actor: "admin:u-admin",
} as unknown as AdminContext;

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

async function paid(method: "CARRIER_TABLE" | "LOCAL_PICKUP") {
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug, { method });
  await clickMockPay(h.ref, "pay");
  await finalizeAttempt(h.attemptId, { trigger: "return" });
  return h;
}

describe("admin order reads", () => {
  it("lists orders newest first, filters by status and searches by email", async () => {
    const a = await paid("LOCAL_PICKUP");
    const art = await buyableArtwork(db);
    const b = await heldOrder(art.slug);
    const all = await listAdminOrders(ctx);
    expect(all.total).toBe(2);
    expect(all.rows[0]?.id).toBe(b.orderId);
    // The first item's titles come from a correlated subquery on the order.
    expect(all.rows[0]?.titleHe).toBe(art.titleHe);
    expect(all.rows[0]?.titleEn).toBe(art.titleEn);
    const paidOnly = await listAdminOrders(ctx, { status: "PAID" });
    expect(paidOnly.rows.map((r) => r.id)).toEqual([a.orderId]);
    const byEmail = await listAdminOrders(ctx, {
      q: a.input.buyer.email.toUpperCase(),
    });
    expect(byEmail.rows.map((r) => r.id)).toEqual([a.orderId]);
  });

  it("the detail has attempts, shipment, a timeline and the buyer token", async () => {
    const h = await paid("LOCAL_PICKUP");
    const d = await getAdminOrder(ctx, h.orderId);
    expect(d?.attempts).toHaveLength(1);
    expect(d?.shipment?.status).toBe("AWAITING_FULFILLMENT");
    expect(d?.timeline.length).toBeGreaterThan(0);
    expect(d?.buyerToken).toHaveLength(32);
    expect(await getAdminOrder(ctx, "not-a-uuid")).toBeNull();
  });
});

describe("Recheck payment", () => {
  it("finalizes a paid-but-unconfirmed attempt and audits the recheck", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    const { result } = await recheckPayment(h.attemptId, ctx);
    expect(result.outcome).toBe("paid");
    expect(result.orderStatus).toBe("PAID");
    const again = await recheckPayment(h.attemptId, ctx);
    expect(again.result.outcome).toBe("already_final");
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payment.rechecked"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.actor).toBe("admin:u-admin");
  });
});

describe("manual tracking", () => {
  it("AWAITING_FULFILLMENT → PACKED → LABEL_CREATED → IN_TRANSIT with events and emails", async () => {
    const h = await paid("CARRIER_TABLE");
    const { result } = await recordManualTracking(
      h.orderId,
      {
        carrierName: "Israel Post",
        trackingNumber: "RR123456789IL",
        trackingUrl: "https://example.test/track/RR123456789IL",
        handedOver: true,
      },
      ctx,
    );
    expect(result.status).toBe("IN_TRANSIT");
    const [s] = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, h.orderId));
    expect(s).toMatchObject({
      carrier: "MANUAL",
      carrierName: "Israel Post",
      trackingNumber: "RR123456789IL",
    });
    expect(s?.shippedAt).toBeInstanceOf(Date);
    const events = await db
      .select()
      .from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, s?.id ?? ""));
    expect(events.map((e) => e.status).sort()).toEqual(
      ["IN_TRANSIT", "LABEL_CREATED", "PACKED"].sort(),
    );
    const jobs = await db.select().from(outboxJobs);
    const keys = jobs.map((j) => j.dedupeKey);
    expect(keys).toContain(
      `email:shipment-update:${s?.id}:LABEL_CREATED:${h.input.buyer.email.toLowerCase()}`,
    );
    expect(keys).toContain(
      `email:shipment-update:${s?.id}:IN_TRANSIT:${h.input.buyer.email.toLowerCase()}`,
    );
    expect(keys.some((k) => k.includes(":PACKED:"))).toBe(false);
  });

  it("a second entry only corrects the tracking details", async () => {
    const h = await paid("CARRIER_TABLE");
    await recordManualTracking(
      h.orderId,
      { carrierName: "Courier", trackingNumber: "ABC123" },
      ctx,
    );
    const { result } = await recordManualTracking(
      h.orderId,
      { carrierName: "Courier", trackingNumber: "ABC124" },
      ctx,
    );
    expect(result.status).toBe("LABEL_CREATED");
    const [s] = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, h.orderId));
    expect(s?.trackingNumber).toBe("ABC124");
  });

  it("refuses pickup orders, unpaid orders, blocked orders and a duplicate tracking number", async () => {
    const pickup = await paid("LOCAL_PICKUP");
    await expect(
      recordManualTracking(
        pickup.orderId,
        { carrierName: "X", trackingNumber: "T1" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NOT_A_CARRIER_SHIPMENT" });

    const art = await buyableArtwork(db);
    const unpaid = await heldOrder(art.slug, { method: "CARRIER_TABLE" });
    await expect(
      recordManualTracking(
        unpaid.orderId,
        { carrierName: "X", trackingNumber: "T2" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PAID" });

    const blocked = await paid("CARRIER_TABLE");
    await execSql(
      "UPDATE orders SET fulfillment_blocked_reason = 'PENDING_CANCELLATION' WHERE id = $1",
      [blocked.orderId],
    );
    await expect(
      recordManualTracking(
        blocked.orderId,
        { carrierName: "X", trackingNumber: "T3" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "FULFILLMENT_BLOCKED" });

    const first = await paid("CARRIER_TABLE");
    const second = await paid("CARRIER_TABLE");
    await recordManualTracking(
      first.orderId,
      { carrierName: "X", trackingNumber: "SAME1" },
      ctx,
    );
    await expect(
      recordManualTracking(
        second.orderId,
        { carrierName: "X", trackingNumber: "SAME1" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TRACKING_NUMBER_IN_USE" });
    const [o] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, second.orderId));
    expect(o?.status).toBe("PAID");
  });
});
