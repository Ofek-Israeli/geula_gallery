import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import {
  markDelivered,
  notice,
  paidCartTestOrder,
  paidTestOrder,
  testAdmin,
} from "../helpers/factories/compliance";
import { fullPacking, testAdminContext } from "../helpers/factories/shipping";

/**
 * Per-work cancellation: the buyer names some works of a cart order; the admin accepts them; only
 * those works are refunded (shipping only with the last work), relisted and dropped from the
 * parcel; the order stays PAID until every work is cancelled and settled. Plus the shared ₪100 fee
 * cap, the over-refund guards, per-work returns and inspection, the schema constraints and the
 * invariants that watch them.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const svc = await import("@/server/cancellations/service");
const ship = await import("@/server/shipping/shipments");
const { sealReview, openReview, cancellationNoticeSchema } = await import(
  "@/server/cancellations/notice"
);
const { executeRefund, settleRefund, requestRefund } = await import(
  "@/server/payments/refunds"
);
const { checkInvariants } = await import("@/server/invariants");
const { buildEmail } = await import("@/server/email/props");

cleanDatabaseBeforeEach();

const admin = testAdmin();
const shipCtx = testAdminContext();
const FEE_CAP = 10_000;

async function cancellation(id: string) {
  const [row] = await db
    .select()
    .from(schema.cancellations)
    .where(eq(schema.cancellations.id, id));
  if (!row) throw new Error("cancellation");
  return row;
}
async function orderRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id));
  if (!row) throw new Error("order");
  return row;
}
async function saleStatus(artworkId: string) {
  const [row] = await db
    .select({ s: schema.artworks.saleStatus })
    .from(schema.artworks)
    .where(eq(schema.artworks.id, artworkId));
  return row?.s;
}
async function shipmentOf(orderId: string) {
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.orderId, orderId));
  if (!row) throw new Error("shipment");
  return row;
}
async function covered(cancellationId: string) {
  const rows = await db
    .select()
    .from(schema.cancellationItems)
    .where(eq(schema.cancellationItems.cancellationId, cancellationId));
  return rows;
}
/** A notice for some works of the order (as the review step records it). */
async function noticeFor(
  o: { number: string; buyerName: string | null },
  items: readonly { id: string; titleHe: string }[] | null,
  reason: "CHANGE_OF_MIND" | "DEFECT" = "CHANGE_OF_MIND",
) {
  const { result } = await svc.recordCancellationNotice(
    notice({ fullName: o.buyerName ?? "", orderNumber: o.number, reason }),
    {
      locale: "he",
      actor: "anonymous",
      ...(items
        ? { requestedItems: items.map((i) => ({ id: i.id, title: i.titleHe })) }
        : {}),
    },
  );
  return result.id;
}
async function settle(refundId: string | null) {
  if (!refundId) throw new Error("no refund");
  expect((await executeRefund(refundId)).result.status).toBe("SUCCEEDED");
  await settleRefund(refundId);
}
const fee = (base: number) => Math.min(Math.round(base * 0.05), FEE_CAP);

describe("buyer preview and intake", () => {
  it("lists the active works only when the order number and the name or email match", async () => {
    const { order: o, items } = await paidCartTestOrder();
    const preview = await svc.previewCancellableItems(
      { orderNumber: o.number, fullName: o.buyerName ?? "", email: undefined },
      "en",
    );
    expect(preview.map((p) => p.id)).toEqual(
      expect.arrayContaining(items.map((i) => i.id)),
    );
    expect(preview).toHaveLength(3);
    expect(
      await svc.previewCancellableItems(
        { orderNumber: o.number, fullName: "Somebody Else", email: undefined },
        "en",
      ),
    ).toEqual([]);
    expect(
      await svc.previewCancellableItems(
        {
          orderNumber: o.number,
          fullName: "Somebody Else",
          email: o.buyerEmail ?? undefined,
        },
        "en",
      ),
    ).toHaveLength(3);
    // A single-work order needs no choice.
    const single = await paidTestOrder();
    expect(
      await svc.previewCancellableItems(
        {
          orderNumber: single.order.number,
          fullName: single.order.buyerName ?? "",
          email: undefined,
        },
        "en",
      ),
    ).toEqual([]);
  });

  it("stores the chosen works; a second notice is a duplicate only when the works overlap", async () => {
    const { order: o, items } = await paidCartTestOrder();
    const [i0, i1, i2] = items as [
      (typeof items)[0],
      (typeof items)[0],
      (typeof items)[0],
    ];
    const a = await noticeFor(o, [i0]);
    const ca = await cancellation(a);
    expect(ca.orderId).toBe(o.id);
    expect(ca.requestedItemIds).toEqual([i0.id]);
    // Suggestions only until acceptance: the covered amounts are written when accepted.
    expect(ca.itemsMinor).toBeNull();
    expect(ca.shippingRefundMinor).toBe(0);
    expect(ca.feeMinor).toBe(fee(i0.priceMinor));
    expect(ca.refundAmountMinor).toBe(i0.priceMinor - fee(i0.priceMinor));
    expect((ca.ackSnapshot as { works?: string[] }).works).toEqual([
      i0.titleHe,
    ]);
    // The acknowledgement email names the work.
    const built = await buildEmail("cancellation-ack", a, "he");
    expect(built.props.works).toEqual([i0.titleHe]);

    const b = await noticeFor(o, [i1]);
    expect((await cancellation(b)).possibleDuplicate).toBe(false);
    const c = await noticeFor(o, [i2, i0]);
    const cc = await cancellation(c);
    expect(cc.possibleDuplicate).toBe(true);
    expect(cc.duplicateOfId).toBe(a);
    // A whole-order notice overlaps everything.
    const d = await noticeFor(o, null);
    expect((await cancellation(d)).duplicateOfId).toBe(a);
    // Naming every work is the whole order.
    const e = await noticeFor(o, items);
    expect((await cancellation(e)).requestedItemIds).toBeNull();
  });
});

describe("partial cancellation before dispatch", () => {
  it("refunds only the work, keeps the order PAID, repacks the parcel and relists only that work", async () => {
    const {
      order: o,
      items,
      artworks,
    } = await paidCartTestOrder([100_000, 200_000, 300_000], {
      method: "CARRIER_TABLE",
    });
    await ship.savePacking(o.id, fullPacking(), shipCtx);
    expect((await shipmentOf(o.id)).status).toBe("PACKED");

    const id = await noticeFor(o, [items[0] as (typeof items)[0]]);
    expect((await orderRow(o.id)).fulfillmentBlockedReason).toBe(
      "PENDING_CANCELLATION",
    );
    const { result } = await svc.acceptCancellation(admin, id);
    expect(result.final).toBe(false);
    expect(result.orderItemIds).toEqual([items[0]?.id]);
    expect(result.feeMinor).toBe(fee(100_000));
    expect(result.refundAmountMinor).toBe(100_000 - fee(100_000));
    expect(result.returnRequired).toBe(false);

    const c = await cancellation(id);
    expect(c.itemsMinor).toBe(100_000);
    expect(c.shippingRefundMinor).toBe(0);
    expect((await covered(id)).map((r) => r.orderItemId)).toEqual([
      items[0]?.id,
    ]);
    // The parcel goes back to be packed again, declared for the remaining works.
    const s = await shipmentOf(o.id);
    expect(s.status).toBe("AWAITING_FULFILLMENT");
    expect(s.packages).toEqual([]);
    expect(s.declaredValueMinor).toBe(500_000);
    // The block is lifted: the rest ships.
    const after = await orderRow(o.id);
    expect(after.status).toBe("PAID");
    expect(after.fulfillmentBlockedReason).toBeNull();
    await ship.savePacking(o.id, fullPacking(), shipCtx);
    expect((await shipmentOf(o.id)).status).toBe("PACKED");

    await settle(result.refundId);
    expect((await orderRow(o.id)).status).toBe("PAID");
    const rel = await svc.relistAfterCancellation(admin, id);
    expect(rel.result.to).toBe("AVAILABLE");
    expect(await saleStatus(artworks[0]?.id as string)).toBe("AVAILABLE");
    expect(await saleStatus(artworks[1]?.id as string)).toBe("SOLD");
    expect(await saleStatus(artworks[2]?.id as string)).toBe("SOLD");
    const live = await db
      .select()
      .from(schema.sales)
      .where(
        and(eq(schema.sales.orderId, o.id), isNull(schema.sales.voidedAt)),
      );
    expect(live).toHaveLength(2);

    const report = await checkInvariants({ graceMinutes: 1_000 });
    expect(
      report.violations.filter(
        (v) =>
          v.check !== "captured_attempt_has_receipt" &&
          v.check !== "settled_refund_has_credit_note",
      ),
    ).toEqual([]);
  });

  it.each(["LABEL_CREATED", "PICKUP_SCHEDULED"] as const)(
    "a parcel in %s goes back to AWAITING_FULFILLMENT and drops the unused label",
    async (status) => {
      const { order: o, items } = await paidCartTestOrder([100_000, 200_000], {
        method: "CARRIER_TABLE",
      });
      await ship.savePacking(o.id, fullPacking(), shipCtx);
      await execSql(
        "UPDATE shipments SET status = $2, tracking_number = 'WB123', label_file_key = 'labels/x.pdf' WHERE order_id = $1",
        [o.id, status],
      );
      const id = await noticeFor(o, [items[1] as (typeof items)[0]]);
      await svc.acceptCancellation(admin, id);
      const s = await shipmentOf(o.id);
      expect(s.status).toBe("AWAITING_FULFILLMENT");
      expect(s.trackingNumber).toBeNull();
      expect(s.labelFileKey).toBeNull();
      expect(s.declaredValueMinor).toBe(100_000);
      const events = await db
        .select()
        .from(schema.shipmentEvents)
        .where(eq(schema.shipmentEvents.shipmentId, s.id));
      expect(events.map((e) => e.status)).toContain("AWAITING_FULFILLMENT");
    },
  );
});

describe("amounts across several cancellations", () => {
  it("shares one ₪100 fee cap; the last cancellation refunds shipping and only then is the order CANCELLED", async () => {
    const { order: o, items } = await paidCartTestOrder([1_000_000, 500_000], {
      method: "CARRIER_TABLE",
    });
    const extra = o.shippingMinor + o.insuranceMinor;
    expect(extra).toBeGreaterThan(0);

    const first = await noticeFor(o, [items[0] as (typeof items)[0]]);
    const a = await svc.acceptCancellation(admin, first);
    expect(a.result.feeMinor).toBe(FEE_CAP); // 5% of ₪10,000 → capped
    expect(a.result.refundAmountMinor).toBe(1_000_000 - FEE_CAP);
    await settle(a.result.refundId);
    expect((await orderRow(o.id)).status).toBe("PAID");

    const second = await noticeFor(o, [items[1] as (typeof items)[0]]);
    const b = await svc.acceptCancellation(admin, second);
    expect(b.result.final).toBe(true);
    expect(b.result.feeMinor).toBe(0); // the order's cap is used up
    expect(b.result.refundAmountMinor).toBe(500_000 + extra);
    const c2 = await cancellation(second);
    expect(c2.shippingRefundMinor).toBe(extra);
    expect((await shipmentOf(o.id)).status).toBe("CANCELLED");
    // Not CANCELLED before the last refund settles.
    expect((await orderRow(o.id)).status).toBe("PAID");
    await settle(b.result.refundId);
    const done = await orderRow(o.id);
    expect(done.status).toBe("CANCELLED");
    expect(done.statusReason).toBe("BUYER_CANCELLATION");
  });

  it("a notice closed as a duplicate uses none of the fee cap and none of the shipping", async () => {
    const { order: o } = await paidCartTestOrder([1_000_000, 500_000], {
      method: "CARRIER_TABLE",
    });
    const first = await noticeFor(o, null);
    const second = await noticeFor(o, null);
    expect((await cancellation(second)).duplicateOfId).toBe(first);
    const [orig] = await db
      .select({ number: schema.cancellations.number })
      .from(schema.cancellations)
      .where(eq(schema.cancellations.id, second));
    await svc.closeAsDuplicate(admin, first, orig?.number as string);
    const { result } = await svc.acceptCancellation(admin, second);
    expect(result.feeMinor).toBe(FEE_CAP);
    expect(result.refundAmountMinor).toBe(o.totalMinor - FEE_CAP);
    expect((await cancellation(second)).shippingRefundMinor).toBe(
      o.shippingMinor + o.insuranceMinor,
    );
  });

  it("a defect cancellation withholds no fee", async () => {
    const { order: o, items } = await paidCartTestOrder([400_000, 100_000]);
    const id = await noticeFor(o, [items[0] as (typeof items)[0]], "DEFECT");
    const { result } = await svc.acceptCancellation(admin, id);
    expect(result.feeMinor).toBe(0);
    expect(result.refundAmountMinor).toBe(400_000);
  });

  it("the admin may narrow the works; the amounts follow the choice", async () => {
    const { order: o, items } = await paidCartTestOrder();
    const id = await noticeFor(o, null);
    const { result } = await svc.acceptCancellation(admin, id, {
      orderItemIds: [items[2]?.id as string],
      feeMinor: 0,
    });
    expect(result.final).toBe(false);
    expect(result.feeMinor).toBe(0);
    expect(result.refundAmountMinor).toBe(300_000);
    expect((await covered(id)).map((r) => r.orderItemId)).toEqual([
      items[2]?.id,
    ]);
  });

  it("an earlier goodwill refund is absorbed by the last cancellation", async () => {
    const { order: o, attemptId } = await paidCartTestOrder([200_000, 100_000]);
    await requestRefund({
      attemptId,
      amountMinor: o.totalMinor - 1_000,
      reason: "ADMIN",
      requestedBy: admin.actor,
    });
    const id = await noticeFor(o, null, "DEFECT");
    const { result } = await svc.acceptCancellation(admin, id);
    expect(result.final).toBe(true);
    expect(result.refundAmountMinor).toBe(1_000);
  });

  it("nothing left to refund: no refund row, and the order is CANCELLED at once", async () => {
    const { order: o, attemptId } = await paidCartTestOrder([200_000, 100_000]);
    const { result: r } = await requestRefund({
      attemptId,
      amountMinor: o.totalMinor,
      reason: "ADMIN",
      requestedBy: admin.actor,
    });
    await settle(r.refundId);
    const id = await noticeFor(o, null, "DEFECT");
    const { result } = await svc.acceptCancellation(admin, id);
    expect(result.refundAmountMinor).toBe(0);
    expect(result.refundId).toBeNull();
    expect((await orderRow(o.id)).status).toBe("CANCELLED");
  });
});

describe("over-refund guards", () => {
  it("a work is cancelled once: a second notice for it has nothing left, a forced choice is refused", async () => {
    const { order: o, items } = await paidCartTestOrder();
    const i0 = items[0] as (typeof items)[0];
    const a = await noticeFor(o, [i0]);
    const b = await noticeFor(o, [i0]);
    await svc.acceptCancellation(admin, a);
    await expect(svc.acceptCancellation(admin, b)).rejects.toMatchObject({
      code: "NO_ITEMS",
    });
    await expect(
      svc.acceptCancellation(admin, b, { orderItemIds: [i0.id] }),
    ).rejects.toMatchObject({ code: "ITEM_NOT_ACTIVE" });
    await expect(svc.acceptCancellation(admin, a)).rejects.toMatchObject({
      code: "NOT_RECEIVED",
    });
  });

  it("two overlapping accepts in parallel: exactly one wins", async () => {
    const { order: o, items } = await paidCartTestOrder();
    const i1 = items[1] as (typeof items)[0];
    const a = await noticeFor(o, [i1]);
    const b = await noticeFor(o, [i1]);
    const results = await Promise.allSettled([
      svc.acceptCancellation(admin, a),
      svc.acceptCancellation(admin, b),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.cancellationItems)
      .where(eq(schema.cancellationItems.orderId, o.id));
    expect(rows).toHaveLength(1);
    const refunds = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.orderId, o.id));
    expect(refunds).toHaveLength(1);
  });
});

describe("returns after delivery", () => {
  it("per-work inspection: the damaged work is not for sale, the other relisted, the kept work stays sold", async () => {
    const { order: o, items, artworks } = await paidCartTestOrder();
    await markDelivered(db, o.id, new Date(Date.now() - 3 * 86_400_000));
    const chosen = [items[0], items[1]] as (typeof items)[0][];
    const id = await noticeFor(o, chosen, "DEFECT");
    const { result } = await svc.acceptCancellation(admin, id);
    expect(result.returnRequired).toBe(true);
    expect(result.refundId).toBeNull();
    expect(
      (await covered(id)).every((r) => r.returnStatus === "AWAITING_RETURN"),
    ).toBe(true);
    const mail = await buildEmail("return-instructions", id, "he");
    expect([...(mail.props.works ?? [])].sort()).toEqual(
      chosen.map((i) => i.titleHe).sort(),
    );

    await svc.recordReturnReceived(admin, id, { tracking: "RR1" });
    await svc.recordInspection(admin, id, {
      damaged: true,
      damagedItemIds: [items[0]?.id as string],
    });
    const states = await covered(id);
    expect(
      Object.fromEntries(states.map((r) => [r.orderItemId, r.returnStatus])),
    ).toEqual({
      [items[0]?.id as string]: "INSPECTED_DAMAGED",
      [items[1]?.id as string]: "INSPECTED_OK",
    });
    expect((await cancellation(id)).returnStatus).toBe("INSPECTED_DAMAGED");
    await expect(
      svc.recordInspection(admin, id, { damaged: false }),
    ).rejects.toMatchObject({ code: "NOT_RECEIVED_BACK" });

    const { result: r } = await svc.refundCancellation(admin, id);
    await settle(r.refundId);
    expect((await orderRow(o.id)).status).toBe("PAID");
    const rel = await svc.relistAfterCancellation(admin, id);
    expect(rel.result.to).toBe("MIXED");
    expect(await saleStatus(artworks[0]?.id as string)).toBe("NOT_FOR_SALE");
    expect(await saleStatus(artworks[1]?.id as string)).toBe("AVAILABLE");
    expect(await saleStatus(artworks[2]?.id as string)).toBe("SOLD");
  });
});

describe("schema and invariants", () => {
  it("refuses a second row for a work, an item of another order and a refund above the base", async () => {
    const { order: o, items } = await paidCartTestOrder([100_000, 200_000]);
    const other = await paidTestOrder();
    const id = await noticeFor(o, [items[0] as (typeof items)[0]]);
    await svc.acceptCancellation(admin, id);
    await expect(
      execSql(
        "INSERT INTO cancellation_items (order_item_id, cancellation_id, order_id) VALUES ($1, $2, $3)",
        [items[0]?.id, id, o.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const [foreign] = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, other.order.id));
    await expect(
      execSql(
        "INSERT INTO cancellation_items (order_item_id, cancellation_id, order_id) VALUES ($1, $2, $3)",
        [foreign?.id, id, o.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      execSql(
        "UPDATE cancellations SET refund_amount_minor = items_minor + shipping_refund_minor + 1, fee_minor = 0 WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("each new invariant flags its violation", async () => {
    const { order: o, items } = await paidCartTestOrder();
    const id = await noticeFor(o, [items[0] as (typeof items)[0]]);
    await svc.acceptCancellation(admin, id);
    const checks = async () =>
      new Set(
        (await checkInvariants({ graceMinutes: 1_000 })).violations.map(
          (v) => v.check,
        ),
      );
    expect(await checks()).not.toContain("cancellation_items_match_amounts");

    await execSql(
      "UPDATE cancellations SET items_minor = items_minor + 1 WHERE id = $1",
      [id],
    );
    expect(await checks()).toContain("cancellation_items_match_amounts");

    await execSql(
      "UPDATE sales SET voided_at = now(), void_reason = 'RELIST' WHERE order_item_id = $1",
      [items[1]?.id],
    );
    expect(await checks()).toContain("active_item_has_sale");

    await execSql(
      "UPDATE sales SET voided_at = now(), void_reason = 'CANCELLATION:C-ZZZZZZ' WHERE order_item_id = $1",
      [items[2]?.id],
    );
    expect(await checks()).toContain("cancellation_void_has_item");

    await execSql(
      "UPDATE orders SET status = 'CANCELLED', status_reason = 'BUYER_CANCELLATION', cancelled_at = now() WHERE id = $1",
      [o.id],
    );
    expect(await checks()).toContain("order_cancellation_state");
  });
});

describe("review payload v2", () => {
  it("carries the offered works; a v1-shaped payload still opens without them", () => {
    const parsed = cancellationNoticeSchema.parse({
      fullName: "Dana Levi",
      orderNumber: "GG-ABC123",
      eligibleGroup: "NONE",
    });
    const now = new Date("2026-10-01T10:00:00Z");
    const works = [
      { id: "00000000-0000-4000-8000-000000000001", title: "A" },
      { id: "00000000-0000-4000-8000-000000000002", title: "B" },
    ];
    const opened = openReview(sealReview(parsed, "en", now, works), now);
    expect(opened?.items).toEqual(works);
    expect(openReview(sealReview(parsed, "en", now), now)?.items).toEqual([]);
  });
});
