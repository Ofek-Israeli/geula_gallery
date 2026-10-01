import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import {
  fullPacking,
  packingPhotoKey,
  paidShipmentOrder,
  testAdminContext,
} from "../helpers/factories/shipping";

/**
 * Spec §10.3 `shipments`: manual transitions; the label claim and LABEL_UNKNOWN; the export
 * declaration; the RECEIVED-cancellation block and its override; pickup collection needs the
 * disclosure. Delivery sets the order's cancellation window with WS6's real `deadlines.ts`.
 */
const { db } = await import("@/server/db/client");
const { cancellationWindow } = await import("@/lib/deadlines");
const {
  adminAlerts,
  auditLog,
  cancellations,
  emailMessages,
  orders,
  outboxJobs,
  shipmentEvents,
  shipments,
} = await import("@/server/db/schema");
const { processOutbox } = await import("@/server/outbox/process");
const svc = await import("@/server/shipping/shipments");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { createMockCarrier } = await import("@/server/shipping/carriers/mock");
const { env } = await import("@/server/env");
const { storage } = await import("@/server/storage");
const {
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} = await import("@/server/integrations/http");
type CarrierAdapter = import("@/server/shipping/types").CarrierAdapter;

const ctx = testAdminContext();
cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

async function shipmentOf(orderId: string) {
  const [s] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId));
  if (!s) throw new Error("no shipment");
  return s;
}
async function orderOf(orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw new Error("no order");
  return o;
}
async function emailKeys(prefix: string) {
  const jobs = await db.select({ key: outboxJobs.dedupeKey }).from(outboxJobs);
  return jobs.map((j) => j.key).filter((k) => k.startsWith(prefix));
}
async function eventsOf(shipmentId: string) {
  return db
    .select()
    .from(shipmentEvents)
    .where(eq(shipmentEvents.shipmentId, shipmentId))
    .orderBy(shipmentEvents.occurredAt);
}

/** A mock adapter whose `createShipment` fails with `error`, then succeeds. */
function failingOnce(error: Error): CarrierAdapter {
  const real = createMockCarrier({ env });
  let calls = 0;
  return {
    ...real,
    createShipment: async (r, c) => {
      calls++;
      if (calls === 1) throw error;
      return (
        real.createShipment as NonNullable<CarrierAdapter["createShipment"]>
      )(r, c);
    },
  };
}

async function internationalReady() {
  const o = await paidShipmentOrder({ country: "US" });
  await svc.savePacking(o.orderId, fullPacking(), ctx);
  await svc.saveCustoms(
    o.orderId,
    {
      hsCode: "9701.91",
      contentsDescriptionEn:
        "Original painting, oil on canvas. Hand-painted unique work of art.",
      declaredValueMinor: 40_000,
      insuredValueMinor: 0,
      exportDeclaration: { status: "PENDING_CARRIER" },
    },
    ctx,
  );
  return o;
}

describe("manual carrier path (IL courier)", () => {
  it("pack (checklist) → tracking → handed over → delivered, with events, emails and deadlines", async () => {
    const o = await paidShipmentOrder();
    const missing = fullPacking().checklist.filter(
      (i) => i !== "disclosureInserted",
    );
    await expect(
      svc.savePacking(o.orderId, { ...fullPacking(), checklist: missing }, ctx),
    ).rejects.toMatchObject({ code: "CHECKLIST_INCOMPLETE" });

    // Domestic and uninsured: no photo needed.
    const packed = await svc.savePacking(o.orderId, fullPacking([]), ctx);
    expect(packed.result.status).toBe("PACKED");
    let s = await shipmentOf(o.orderId);
    expect(s.packages).toEqual(fullPacking().packages);
    expect(
      (s.checklist as { items: Record<string, boolean> }).items
        .disclosureInserted,
    ).toBe(true);

    const tracked = await svc.recordManualTracking(
      o.orderId,
      { carrierName: "Israel Post", trackingNumber: "RR000000001IL" },
      ctx,
    );
    expect(tracked.result.status).toBe("LABEL_CREATED");
    await svc.markHandedOver(o.orderId, ctx);
    s = await shipmentOf(o.orderId);
    expect(s.status).toBe("IN_TRANSIT");
    expect(s.shippedAt).not.toBeNull();

    const deliveredAt = new Date();
    await svc.addManualEvent(
      o.orderId,
      {
        status: "DELIVERED",
        occurredAt: deliveredAt,
        description: "Signed for",
      },
      ctx,
    );
    s = await shipmentOf(o.orderId);
    expect(s.status).toBe("DELIVERED");
    expect(s.deliveredAt?.toISOString()).toBe(deliveredAt.toISOString());
    expect(
      (s.insuranceClaimDeadlineAt?.getTime() ?? 0) - deliveredAt.getTime(),
    ).toBeGreaterThanOrEqual(30 * 86_400_000 - 3_600_000);
    const order = await orderOf(o.orderId);
    expect(order.deliveredAt?.toISOString()).toBe(deliveredAt.toISOString());
    expect(order.cancellationWindowEndsAt?.toISOString()).toBe(
      cancellationWindow({
        deliveredAt,
        disclosureSentAt: order.disclosureSentAt,
        eligibleGroup: "NONE",
        conversationTookPlace: order.conversationTookPlace ?? false,
      }).end?.toISOString(),
    );
    // 14 Jerusalem days, to the end of the last day.
    const extra =
      (order.cancellationWindowEndsAt?.getTime() ?? 0) -
      (deliveredAt.getTime() + 14 * 86_400_000);
    expect(extra).toBeGreaterThanOrEqual(-3_600_000);
    expect(extra).toBeLessThan(86_400_000 + 3_600_000);

    const events = await eventsOf(s.id);
    expect(events.map((e) => e.status)).toEqual([
      "PACKED",
      "LABEL_CREATED",
      "IN_TRANSIT",
      "DELIVERED",
    ]);
    // One buyer email per status; packing is silent.
    const keys = await emailKeys(`email:shipment-update:${s.id}:`);
    expect(keys.map((k) => k.split(":")[3]).sort()).toEqual([
      "DELIVERED",
      "IN_TRANSIT",
      "LABEL_CREATED",
    ]);

    // Final: nothing moves a delivered shipment.
    await expect(
      svc.addManualEvent(
        o.orderId,
        { status: "IN_TRANSIT", occurredAt: new Date(), description: "x" },
        ctx,
      ),
    ).rejects.toMatchObject({ name: "IllegalTransitionError" });
    // A note is fine.
    await svc.addManualEvent(
      o.orderId,
      {
        status: null,
        occurredAt: new Date(),
        description: "Buyer confirmed by phone",
      },
      ctx,
    );
    expect((await eventsOf(s.id)).at(-1)?.status).toBeNull();
  });

  it("artist delivery: packed → out for delivery → delivered behind the disclosure guard", async () => {
    const o = await paidShipmentOrder({ method: "ARTIST_DELIVERY" });
    await svc.savePacking(o.orderId, fullPacking([]), ctx);
    await svc.startArtistDelivery(o.orderId, ctx);
    await expect(
      svc.markArtistDelivered(o.orderId, { disclosureHandedOver: false }, ctx),
    ).rejects.toMatchObject({ code: "DISCLOSURE_REQUIRED" });
    await svc.markArtistDelivered(
      o.orderId,
      { disclosureHandedOver: true },
      ctx,
    );
    expect((await shipmentOf(o.orderId)).status).toBe("DELIVERED");
    expect((await orderOf(o.orderId)).disclosureHandedOverAt).not.toBeNull();
  });
});

describe("customs values in the declared currency", () => {
  it("a USD order declares USD on the invoice lines and the carrier line items (never the ILS item value)", async () => {
    const { getCommercialInvoice } = await import(
      "@/server/shipping/documents"
    );
    const o = await paidShipmentOrder({ country: "US" });
    const order = await orderOf(o.orderId);
    expect(order.currency).toBe("USD");
    await svc.savePacking(o.orderId, fullPacking([packingPhotoKey(1)]), ctx);
    await svc.saveCustoms(
      o.orderId,
      {
        hsCode: "9701.91",
        contentsDescriptionEn: "Original painting, oil on canvas.",
        declaredValueMinor: order.itemsTotalMinor,
        insuredValueMinor: 0,
        exportDeclaration: { status: "PENDING_CARRIER" },
      },
      ctx,
    );
    const ci = await getCommercialInvoice(ctx, o.orderId);
    expect(ci?.currency).toBe("USD");
    expect(ci?.lines.map((l) => l.unitValueMinor)).toEqual([
      order.itemsTotalMinor,
    ]);
    expect(ci?.goodsTotalMinor).toBe(order.itemsTotalMinor);
    expect(ci?.invoiceTotalMinor).toBe(order.totalMinor);

    const real = createMockCarrier({ env });
    let request:
      | Parameters<NonNullable<CarrierAdapter["createShipment"]>>[0]
      | null = null;
    const carrier: CarrierAdapter = {
      ...real,
      createShipment: async (r, c) => {
        request = r;
        return (
          real.createShipment as NonNullable<CarrierAdapter["createShipment"]>
        )(r, c);
      },
    };
    const s = await shipmentOf(o.orderId);
    await svc.requestLabel(s.id, ctx, { carrier });
    const sent = request as unknown as {
      declaredValueMinor: number;
      declaredCurrency: string;
      lineItems: { valueMinor: number }[];
    } | null;
    expect(sent?.declaredCurrency).toBe("USD");
    expect(sent?.declaredValueMinor).toBe(order.itemsTotalMinor);
    expect(sent?.lineItems.map((l) => l.valueMinor)).toEqual([
      order.itemsTotalMinor,
    ]);
  });
});

describe("label claim protocol", () => {
  it("requires photos abroad, customs, then creates a private label (attempt 1)", async () => {
    const o = await paidShipmentOrder({ country: "US" });
    let s = await shipmentOf(o.orderId);
    expect(s.carrier).toBe("MOCK");
    expect(s.exportDeclStatus).toBe("REQUIRED"); // USD 400 > USD 200
    await expect(
      svc.savePacking(o.orderId, fullPacking([]), ctx),
    ).rejects.toMatchObject({ code: "PHOTOS_REQUIRED" });
    await expect(
      svc.savePacking(o.orderId, fullPacking(["artworks/x/y.jpg"]), ctx),
    ).rejects.toMatchObject({ code: "PHOTO_KEY_INVALID" });
    await svc.savePacking(
      o.orderId,
      fullPacking([packingPhotoKey(1), packingPhotoKey(2)]),
      ctx,
    );
    await expect(svc.requestLabel(s.id, ctx)).rejects.toMatchObject({
      code: "CUSTOMS_REQUIRED",
    });
    await expect(
      svc.saveCustoms(
        o.orderId,
        {
          hsCode: "9701.91",
          contentsDescriptionEn: "ציור מקורי",
          declaredValueMinor: 40_000,
          insuredValueMinor: 0,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "DESCRIPTION_LATIN" });
    await expect(
      svc.saveCustoms(
        o.orderId,
        {
          hsCode: "9701.91",
          contentsDescriptionEn: "Original painting",
          declaredValueMinor: 40_000,
          insuredValueMinor: 0,
          exportDeclaration: { status: "RECORDED", number: "" },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "EXPORT_DECLARATION_NUMBER" });
    await svc.saveCustoms(
      o.orderId,
      {
        hsCode: "9701.91",
        contentsDescriptionEn: "Original painting, oil on canvas.",
        declaredValueMinor: 40_000,
        insuredValueMinor: 0,
        exportDeclaration: { status: "RECORDED", number: "IL-EXP-0001" },
      },
      ctx,
    );
    s = await shipmentOf(o.orderId);
    expect(s.exportDeclStatus).toBe("RECORDED");
    expect(s.exportDeclarationNumber).toBe("IL-EXP-0001");
    expect(s.commercialInvoiceNumber).toMatch(/^CI-GG-/);

    const res = await svc.requestLabel(s.id, ctx);
    expect(res.result).toMatchObject({ status: "LABEL_CREATED" });
    s = await shipmentOf(o.orderId);
    expect(s.trackingNumber).toMatch(/^MOCK\d{10}$/);
    expect(s.labelAttempt).toBe(1);
    expect(s.idempotencyKey).toBe(svc.uuidFromName(`${o.orderId}:1`));
    expect(s.messageReference).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.labelFileKey).toMatch(/^labels\//);
    const file = await storage().get(s.labelFileKey as string, "private");
    expect(file?.contentType).toBe("application/pdf");
    expect(await storage().get(s.labelFileKey as string, "public")).toBeNull();
    expect((await eventsOf(s.id)).map((e) => e.status)).toEqual([
      "PACKED",
      "LABEL_REQUESTED",
      "LABEL_CREATED",
    ]);
    expect(
      await emailKeys(`email:shipment-update:${s.id}:LABEL_CREATED`),
    ).toHaveLength(1);
    // A second label for the same shipment is refused.
    await expect(svc.requestLabel(s.id, ctx)).rejects.toMatchObject({
      code: "SHIPMENT_STATE",
    });
  });

  it("a clear refusal goes back to PACKED; the retry is attempt 2 with a new key", async () => {
    const o = await internationalReady();
    const s0 = await shipmentOf(o.orderId);
    const carrier = failingOnce(
      new ProviderRejectedError("mock", "HTTP 400", 400),
    );
    const first = await svc.requestLabel(s0.id, ctx, { carrier });
    expect(first.result).toEqual({ status: "PACKED", error: "LABEL_REJECTED" });
    const s1 = await shipmentOf(o.orderId);
    expect(s1.labelAttempt).toBe(1);
    const second = await svc.requestLabel(s0.id, ctx, { carrier });
    expect(second.result.status).toBe("LABEL_CREATED");
    const s2 = await shipmentOf(o.orderId);
    expect(s2.labelAttempt).toBe(2);
    expect(s2.idempotencyKey).toBe(svc.uuidFromName(`${o.orderId}:2`));
    expect(s2.idempotencyKey).not.toBe(s1.idempotencyKey);
    expect(s2.messageReference).not.toBe(s1.messageReference);
  });

  it("a timeout → LABEL_UNKNOWN + alert; never re-called until the admin resolves it", async () => {
    const o = await internationalReady();
    const s0 = await shipmentOf(o.orderId);
    const carrier = failingOnce(new ProviderTimeoutError("mock"));
    const first = await svc.requestLabel(s0.id, ctx, { carrier });
    expect(first.result).toEqual({
      status: "LABEL_UNKNOWN",
      error: "LABEL_UNKNOWN",
    });
    const alerts = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "LABEL_UNKNOWN"));
    expect(alerts).toHaveLength(1);
    await expect(
      svc.requestLabel(s0.id, ctx, { carrier }),
    ).rejects.toMatchObject({
      code: "SHIPMENT_STATE",
    });
    // No label in MyDHL → back to PACKED, then a new claim.
    const resolved = await svc.resolveUnknownLabel(
      o.orderId,
      { outcome: "none" },
      ctx,
    );
    expect(resolved.result.status).toBe("PACKED");
    const again = await svc.requestLabel(s0.id, ctx, { carrier });
    expect(again.result.status).toBe("LABEL_CREATED");
    expect((await shipmentOf(o.orderId)).labelAttempt).toBe(2);
    expect((await eventsOf(s0.id)).map((e) => e.status)).toEqual([
      "PACKED",
      "LABEL_REQUESTED",
      "LABEL_UNKNOWN",
      "LABEL_REQUESTED",
      "PACKED",
      "LABEL_REQUESTED",
      "LABEL_CREATED",
    ]);
  });

  it("a 5xx is unknown too; a label found in MyDHL is recorded by hand", async () => {
    const o = await internationalReady();
    const s0 = await shipmentOf(o.orderId);
    const carrier = failingOnce(
      new ProviderUnavailableError("mock", "HTTP 503", 503),
    );
    expect(
      (await svc.requestLabel(s0.id, ctx, { carrier })).result.status,
    ).toBe("LABEL_UNKNOWN");
    await expect(
      svc.resolveUnknownLabel(
        o.orderId,
        { outcome: "found", waybill: "a b" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "WAYBILL_INVALID" });
    await svc.resolveUnknownLabel(
      o.orderId,
      { outcome: "found", waybill: "1234567890" },
      ctx,
    );
    const s = await shipmentOf(o.orderId);
    expect(s.status).toBe("LABEL_CREATED");
    expect(s.trackingNumber).toBe("1234567890");
  });

  it("a claim that never finished can be marked unknown only once it is stale", async () => {
    const o = await internationalReady();
    await execSql(
      "UPDATE shipments SET status = 'LABEL_REQUESTED' WHERE order_id = $1",
      [o.orderId],
    );
    await expect(
      svc.markLabelRequestUnknown(o.orderId, ctx),
    ).rejects.toMatchObject({
      code: "LABEL_REQUEST_IN_FLIGHT",
    });
    await svc.markLabelRequestUnknown(o.orderId, ctx, {
      now: () => new Date(Date.now() + 3 * 60_000),
    });
    expect((await shipmentOf(o.orderId)).status).toBe("LABEL_UNKNOWN");
  });

  it("IL courier parcels have no label carrier", async () => {
    const o = await paidShipmentOrder();
    await svc.savePacking(o.orderId, fullPacking([]), ctx);
    await expect(
      svc.requestLabel((await shipmentOf(o.orderId)).id, ctx),
    ).rejects.toMatchObject({ code: "NO_LABEL_CARRIER" });
    await expect(
      svc.saveCustoms(
        o.orderId,
        {
          hsCode: "9701.91",
          contentsDescriptionEn: "Original painting",
          declaredValueMinor: 1,
          insuredValueMinor: 0,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "NOT_INTERNATIONAL" });
  });
});

describe("cancellation block", () => {
  async function notice(orderId: string, status: "RECEIVED" | "ACCEPTED") {
    await db.insert(cancellations).values({
      number: `C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      orderId,
      status,
      fullName: "Test Buyer",
      ...(status === "ACCEPTED" ? {} : {}),
    });
  }

  it("a RECEIVED notice blocks until overridden with a reason (audited)", async () => {
    const o = await paidShipmentOrder();
    await notice(o.orderId, "RECEIVED");
    await expect(
      svc.savePacking(o.orderId, fullPacking([]), ctx),
    ).rejects.toMatchObject({
      code: "FULFILLMENT_BLOCKED",
      block: { code: "CANCELLATION_PENDING" },
    });
    await expect(
      svc.overrideCancellationBlock(o.orderId, " ", ctx),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await svc.overrideCancellationBlock(
      o.orderId,
      "Buyer withdrew the notice by phone",
      ctx,
    );
    expect((await shipmentOf(o.orderId)).cancellationOverrideReason).toBe(
      "Buyer withdrew the notice by phone",
    );
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "shipment.cancellation_override")));
    expect(audits).toHaveLength(1);
    expect(
      (await svc.savePacking(o.orderId, fullPacking([]), ctx)).result.status,
    ).toBe("PACKED");
  });

  it("the PENDING_CANCELLATION block flag is overridable too; other blocks are not", async () => {
    const o = await paidShipmentOrder();
    await execSql(
      "UPDATE orders SET fulfillment_blocked_reason = 'PENDING_CANCELLATION' WHERE id = $1",
      [o.orderId],
    );
    await svc.overrideCancellationBlock(
      o.orderId,
      "Checked with the buyer",
      ctx,
    );
    await svc.savePacking(o.orderId, fullPacking([]), ctx);

    const d = await paidShipmentOrder();
    await execSql(
      "UPDATE orders SET fulfillment_blocked_reason = 'DISPUTE' WHERE id = $1",
      [d.orderId],
    );
    await expect(
      svc.overrideCancellationBlock(d.orderId, "Please let me", ctx),
    ).rejects.toMatchObject({ code: "NOTHING_TO_OVERRIDE" });
    await expect(
      svc.savePacking(d.orderId, fullPacking([]), ctx),
    ).rejects.toMatchObject({
      code: "FULFILLMENT_BLOCKED",
      block: { code: "FULFILLMENT_BLOCKED", reason: "DISPUTE" },
    });
  });

  it("an ACCEPTED cancellation blocks for good; the WS6 hook cancels an unshipped parcel", async () => {
    const o = await paidShipmentOrder();
    await notice(o.orderId, "ACCEPTED");
    await expect(
      svc.overrideCancellationBlock(o.orderId, "anything at all", ctx),
    ).rejects.toMatchObject({ code: "NOTHING_TO_OVERRIDE" });
    await expect(
      svc.savePacking(o.orderId, fullPacking([]), ctx),
    ).rejects.toMatchObject({
      block: { code: "CANCELLATION_ACCEPTED" },
    });
    const res = await db.transaction((tx) =>
      svc.cancelShipmentForOrder(tx, o.orderId, "system"),
    );
    expect(res).toEqual({
      cancelled: true,
      shipped: false,
      pickupConfirmation: null,
    });
    expect((await shipmentOf(o.orderId)).status).toBe("CANCELLED");

    const shipped = await paidShipmentOrder();
    await svc.recordManualTracking(
      shipped.orderId,
      { carrierName: "Courier", trackingNumber: "CR0001", handedOver: true },
      ctx,
    );
    const r2 = await db.transaction((tx) =>
      svc.cancelShipmentForOrder(tx, shipped.orderId, "system"),
    );
    expect(r2).toMatchObject({ cancelled: false, shipped: true });
  });
});

describe("pickup", () => {
  it("ready for pickup emails the address; collection needs the disclosure", async () => {
    const o = await paidShipmentOrder({ method: "LOCAL_PICKUP" });
    await expect(
      svc.savePacking(o.orderId, fullPacking([]), ctx),
    ).rejects.toMatchObject({
      code: "PICKUP_NOT_PACKED",
    });
    await svc.markReadyForPickup(o.orderId, ctx);
    const s = await shipmentOf(o.orderId);
    expect(s.status).toBe("READY_FOR_PICKUP");
    expect(await emailKeys(`email:ready-for-pickup:${s.id}:`)).toHaveLength(1);

    await expect(
      svc.markCollected(o.orderId, { disclosureHandedOver: false }, ctx),
    ).rejects.toMatchObject({ code: "DISCLOSURE_REQUIRED" });
    await svc.markCollected(o.orderId, { disclosureHandedOver: true }, ctx);
    const order = await orderOf(o.orderId);
    expect(order.disclosureHandedOverAt).not.toBeNull();
    expect(order.deliveredAt).not.toBeNull();
    expect((await shipmentOf(o.orderId)).status).toBe("COLLECTED");
    expect(
      await emailKeys(`email:shipment-update:${s.id}:COLLECTED`),
    ).toHaveLength(1);
  });

  it("an emailed disclosure is enough", async () => {
    const o = await paidShipmentOrder({ method: "LOCAL_PICKUP" });
    await execSql(
      "UPDATE orders SET disclosure_sent_at = now() WHERE id = $1",
      [o.orderId],
    );
    await svc.markReadyForPickup(o.orderId, ctx);
    await svc.markCollected(o.orderId, { disclosureHandedOver: false }, ctx);
    expect((await orderOf(o.orderId)).disclosureHandedOverAt).toBeNull();
  });
});

describe("shipment row", () => {
  it("createShipmentForOrder is idempotent", async () => {
    const o = await paidShipmentOrder();
    const a = await svc.createShipmentForOrder(o.orderId, ctx);
    expect(a.result.shipmentId).toBe(o.shipmentId);
    await execSql("DELETE FROM shipment_events WHERE shipment_id = $1", [
      o.shipmentId,
    ]);
    await execSql("DELETE FROM shipments WHERE id = $1", [o.shipmentId]);
    const b = await svc.createShipmentForOrder(o.orderId, ctx);
    expect(b.result.shipmentId).not.toBe(o.shipmentId);
    const s = await shipmentOf(o.orderId);
    expect(s).toMatchObject({
      method: "CARRIER_TABLE",
      carrier: "MANUAL",
      exportDeclStatus: "NOT_REQUIRED",
    });
  });
});

describe("shipping emails", () => {
  it("send in the buyer's locale: ready for pickup (with the address) and shipment updates", async () => {
    const pickup = await paidShipmentOrder({ method: "LOCAL_PICKUP" });
    await svc.markReadyForPickup(pickup.orderId, ctx);
    const courier = await paidShipmentOrder();
    await svc.recordManualTracking(
      courier.orderId,
      {
        carrierName: "Israel Post",
        trackingNumber: "RR000000003IL",
        trackingUrl: "https://example.test/track/RR000000003IL",
        handedOver: true,
      },
      ctx,
    );
    for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
    const sent = await db.select().from(emailMessages);
    const ready = sent.find((m) => m.template === "ready-for-pickup");
    expect(ready?.status).toBe("SENT");
    expect(ready?.subject).toContain("מוכנה לאיסוף");
    expect(ready?.html).toContain("data-pickup-address");
    const updates = sent.filter((m) => m.template === "shipment-update");
    expect(updates.map((m) => m.status)).toEqual(["SENT", "SENT"]);
    const inTransit = updates.find((m) => m.html?.includes("היצירה בדרך"));
    expect(inTransit?.html).toContain("RR000000003IL");
    expect(inTransit?.html).toContain(
      "https://example.test/track/RR000000003IL",
    );
    expect(inTransit?.html).toContain('dir="rtl"');
  });
});
