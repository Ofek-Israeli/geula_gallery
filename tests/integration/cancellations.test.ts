import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import {
  markDelivered,
  notice,
  paidTestOrder,
  testAdmin,
  validIsraeliId,
} from "../helpers/factories/compliance";

/**
 * Spec §10.3 `cancellations`: auto-match; double submission and web-then-phone notices both
 * stored; the window including 4 months; conversation detected from a buyer request; a COMPLETED
 * order cancellation → CANCELLED; the fee; the EU regime; the refund due date counted from the
 * notice; relist. Plus the sealed review payload and the masked acknowledgement.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const svc = await import("@/server/cancellations/service");
const { openReview, sealReview, cancellationNoticeSchema } = await import(
  "@/server/cancellations/notice"
);
const { executeRefund, settleRefund } = await import(
  "@/server/payments/refunds"
);
const { decryptAesGcm } = await import("@/server/security/crypto");
const { piiKey } = await import("@/server/security/keys");
const { buildEmail } = await import("@/server/email/props");
const { renderEmail } = await import("@/server/email/render");

cleanDatabaseBeforeEach();

const admin = testAdmin();

async function cancellation(id: string) {
  const [row] = await db
    .select()
    .from(schema.cancellations)
    .where(eq(schema.cancellations.id, id));
  if (!row) throw new Error("cancellation");
  return row;
}
async function order(id: string) {
  const [row] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, id));
  if (!row) throw new Error("order");
  return row;
}
async function emailJobs(template: string) {
  const rows = await db.select().from(schema.outboxJobs);
  return rows.filter(
    (r) => (r.payload as { template?: string }).template === template,
  );
}

describe("cancellation intake", () => {
  it("stores the notice, encrypts the ID, masks the ack and auto-matches by order + email", async () => {
    const { order: o } = await paidTestOrder();
    const id = validIsraeliId();
    const receivedAt = new Date("2026-10-01T09:15:00Z");
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: "Someone Else",
        idNumber: { kind: "IL_ID", value: id },
        orderNumber: o.number,
        email: o.buyerEmail ?? undefined,
        reason: "CHANGE_OF_MIND",
      }),
      { locale: "he", actor: "anonymous", receivedAt },
    );
    const c = await cancellation(result.id);
    expect(c.status).toBe("RECEIVED");
    expect(c.number).toMatch(/^C-[0-9A-Z]{6}$/);
    expect(c.orderId).toBe(o.id);
    expect(c.refundDueAt?.toISOString()).toBe("2026-10-15T09:15:00.000Z");
    expect(c.idNumberLast3).toBe(id.slice(-3));
    expect(c.idNumberEnc).not.toContain(id);
    expect(
      decryptAesGcm(
        piiKey(),
        c.idNumberEnc ?? "",
        `cancellations.id_number:${c.id}`,
      ),
    ).toBe(id);
    expect(JSON.stringify(c.ackSnapshot)).not.toContain(id);
    expect(result.ack.idNumberMasked).toBe(`•••••••${id.slice(-2)}`);
    expect(result.ack.number).toBe(c.number);
    // Matching blocks fulfillment and computes the fee suggestion (₪1,500 → ₪75).
    expect((await order(o.id)).fulfillmentBlockedReason).toBe(
      "PENDING_CANCELLATION",
    );
    expect(c.feeMinor).toBe(Math.min(Math.round(o.totalMinor * 0.05), 10_000));
    expect(c.withinWindow).toBe(true);
    // Acknowledgement and painter emails are enqueued with the notice.
    expect(await emailJobs("cancellation-ack")).toHaveLength(1);
    expect(await emailJobs("painter-cancellation")).toHaveLength(1);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, c.id));
    expect(JSON.stringify(audit)).not.toContain(id);
  });

  it("renders the acknowledgement emails with the ID masked", async () => {
    const id = validIsraeliId();
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: "Ack Person",
        idNumber: { kind: "IL_ID", value: id },
        email: "ack@example.test",
      }),
      { locale: "en", actor: "anonymous" },
    );
    for (const template of [
      "cancellation-ack",
      "painter-cancellation",
    ] as const) {
      const built = await buildEmail(template, result.id, "en");
      const r = await renderEmail(template, built.props, {
        locale: built.locale,
        brand: () => ({
          tradeName: "Geula Gallery",
          address: "Tel Aviv",
          email: "studio@example.com",
          phone: "03-000-0000",
          cancelUrl: "http://localhost/en/cancel",
          siteUrl: "http://localhost",
        }),
        demo: true,
      });
      expect(r.html).not.toContain(id);
      expect(r.text).not.toContain(id);
      expect(r.html).toContain(id.slice(-2));
    }
  });

  it("matches by order number + name; leaves a mismatch for the admin", async () => {
    const { order: o } = await paidTestOrder();
    const byName = await svc.recordCancellationNotice(
      notice({
        fullName: `  ${(o.buyerName ?? "").toLowerCase()} `,
        orderNumber: o.number,
      }),
      { locale: "he", actor: "anonymous" },
    );
    expect((await cancellation(byName.result.id)).orderId).toBe(o.id);

    const stranger = await svc.recordCancellationNotice(
      notice({ fullName: "Not The Buyer", orderNumber: o.number }),
      { locale: "he", actor: "anonymous" },
    );
    const s = await cancellation(stranger.result.id);
    expect(s.orderId).toBeNull();
    expect(s.status).toBe("RECEIVED");
    await svc.matchCancellationToOrder(admin, s.id, o.number);
    const matched = await cancellation(s.id);
    expect(matched.orderId).toBe(o.id);
    expect(matched.possibleDuplicate).toBe(true);
    expect(matched.duplicateOfId).toBe(byName.result.id);
  });

  it("double submission and web-then-phone: every notice is stored and acknowledged", async () => {
    const { order: o } = await paidTestOrder();
    const input = notice({
      fullName: o.buyerName ?? "",
      orderNumber: o.number,
      email: "dup@example.test",
    });
    const [a, b] = await Promise.all([
      svc.recordCancellationNotice(input, { locale: "he", actor: "anonymous" }),
      svc.recordCancellationNotice(input, { locale: "he", actor: "anonymous" }),
    ]);
    const phone = await svc.recordCancellationNotice(
      notice({ fullName: o.buyerName ?? "" }),
      {
        locale: "he",
        actor: admin.actor,
        channel: "PHONE",
        receivedAt: new Date(Date.now() - 60_000),
        orderId: o.id,
      },
    );
    const rows = await db
      .select()
      .from(schema.cancellations)
      .where(eq(schema.cancellations.orderId, o.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.possibleDuplicate)).toHaveLength(2);
    expect(new Set(rows.map((r) => r.number)).size).toBe(3);
    expect((await cancellation(phone.result.id)).channel).toBe("PHONE");
    expect(await emailJobs("cancellation-ack")).toHaveLength(2);
    expect(await emailJobs("painter-cancellation")).toHaveLength(3);
    // The admin closes one duplicate after linking it to the original.
    const original = rows.find((r) => !r.possibleDuplicate);
    const dup = [a, b].map((x) => x.result.id).find((x) => x !== original?.id);
    await svc.closeAsDuplicate(
      admin,
      dup as string,
      original?.number as string,
    );
    const closed = await cancellation(dup as string);
    expect(closed.status).toBe("CLOSED");
    expect(closed.decisionReason).toBe("DUPLICATE");
  });

  it("a notice with no order (ID only) is stored, unmatched, and sets the EU regime when asked", async () => {
    const { result } = await svc.recordCancellationNotice(
      notice({
        idNumber: { kind: "PASSPORT", value: "X1234567" },
        shippedTo: "EU",
      }),
      { locale: "en", actor: "anonymous" },
    );
    const c = await cancellation(result.id);
    expect(c.orderId).toBeNull();
    expect(c.regime).toBe("EU");
  });
});

describe("deadlines and conversation", () => {
  it("grants 4 months when eligible and a conversation is detected from a buyer request", async () => {
    const { order: o } = await paidTestOrder();
    await db.insert(schema.buyerRequests).values({
      kind: "QUESTION",
      name: "Q",
      email: (o.buyerEmail ?? "").toUpperCase(),
      locale: "he",
      message: "is it varnished?",
      createdAt: new Date(o.createdAt.getTime() - 86_400_000),
    });
    // The order was placed before the request was recorded as a conversation.
    await execSql(
      "UPDATE orders SET conversation_took_place = false, conversation_source = NULL WHERE id = $1",
      [o.id],
    );
    const delivered = new Date(Date.now() - 30 * 86_400_000);
    await markDelivered(db, o.id, delivered);
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: o.buyerName ?? "",
        orderNumber: o.number,
        eligibleGroup: "SENIOR_65",
      }),
      { locale: "he", actor: "anonymous" },
    );
    const after = await order(o.id);
    expect(after.conversationTookPlace).toBe(true);
    expect(after.conversationSource).toMatch(/^REQUEST:/);
    const c = await cancellation(result.id);
    // 30 days after delivery: outside 14 days, inside 4 months.
    expect(c.withinWindow).toBe(true);
    expect(c.windowEndsAt && c.windowEndsAt > new Date()).toBe(true);
  });

  it("is outside the window after 14 days without eligibility", async () => {
    const { order: o } = await paidTestOrder();
    await markDelivered(db, o.id, new Date(Date.now() - 20 * 86_400_000));
    const { result } = await svc.recordCancellationNotice(
      notice({ fullName: o.buyerName ?? "", orderNumber: o.number }),
      { locale: "he", actor: "anonymous" },
    );
    expect((await cancellation(result.id)).withinWindow).toBe(false);
  });

  it("the EU regime suggests no fee", async () => {
    const { order: o } = await paidTestOrder();
    await execSql("UPDATE orders SET ship_country = 'DE' WHERE id = $1", [
      o.id,
    ]);
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: o.buyerName ?? "",
        orderNumber: o.number,
        reason: "CHANGE_OF_MIND",
      }),
      { locale: "en", actor: "anonymous" },
    );
    const c = await cancellation(result.id);
    expect(c.regime).toBe("EU");
    expect(c.feeMinor).toBe(0);
  });
});

describe("admin decision", () => {
  it("accept before shipping: shipment cancelled, refund due from the notice, settle → CANCELLED, close, relist", async () => {
    const { order: o, artwork } = await paidTestOrder();
    const receivedAt = new Date(Date.now() - 2 * 86_400_000);
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: o.buyerName ?? "",
        orderNumber: o.number,
        reason: "CHANGE_OF_MIND",
      }),
      { locale: "he", actor: "anonymous", receivedAt },
    );
    // The admin may lower the fee, never raise it.
    const { result: acc } = await svc.acceptCancellation(admin, result.id, {
      feeMinor: 999_999,
    });
    const suggested = Math.min(Math.round(o.totalMinor * 0.05), 10_000);
    expect(acc.feeMinor).toBe(suggested);
    expect(acc.refundAmountMinor).toBe(o.totalMinor - suggested);
    expect(acc.returnRequired).toBe(false);
    const c = await cancellation(result.id);
    expect(c.status).toBe("ACCEPTED");
    expect(c.returnStatus).toBe("NOT_APPLICABLE");
    const [ship] = await db
      .select()
      .from(schema.shipments)
      .where(eq(schema.shipments.orderId, o.id));
    expect(ship?.status).toBe("CANCELLED");
    // Through WS3's `cancelShipmentForOrder`: a SYSTEM event row, no buyer email.
    const events = await db
      .select()
      .from(schema.shipmentEvents)
      .where(eq(schema.shipmentEvents.shipmentId, ship?.id ?? ""));
    expect(events.map((e) => [e.status, e.source])).toContainEqual([
      "CANCELLED",
      "SYSTEM",
    ]);
    const [refund] = await db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.cancellationId, c.id));
    expect(refund?.reason).toBe("CANCELLATION");
    expect(refund?.feeWithheldMinor).toBe(suggested);
    expect(refund?.legalDueAt?.toISOString()).toBe(
      c.refundDueAt?.toISOString(),
    );
    expect(refund?.legalDueAt?.getTime()).toBe(
      (await import("@/lib/deadlines")).refundDueAt(receivedAt).getTime(),
    );

    // Closing before the refund settled is refused.
    await expect(svc.closeCancellation(admin, c.id)).rejects.toMatchObject({
      code: "REFUND_NOT_SETTLED",
    });
    expect((await executeRefund(refund?.id as string)).result.status).toBe(
      "SUCCEEDED",
    );
    await settleRefund(refund?.id as string);
    const cancelled = await order(o.id);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.statusReason).toBe("BUYER_CANCELLATION");
    await svc.closeCancellation(admin, c.id);
    expect((await cancellation(c.id)).status).toBe("CLOSED");

    const { result: rel } = await svc.relistAfterCancellation(admin, c.id);
    expect(rel.to).toBe("AVAILABLE");
    const [art] = await db
      .select()
      .from(schema.artworks)
      .where(eq(schema.artworks.id, artwork.id));
    expect(art?.saleStatus).toBe("AVAILABLE");
    const live = await db
      .select()
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.artworkId, artwork.id),
          eq(schema.sales.orderId, o.id),
        ),
      );
    expect(live.every((s) => s.voidedAt !== null)).toBe(true);
  });

  it("a COMPLETED, delivered order: accept → return instructions; refund → CANCELLED", async () => {
    const { order: o } = await paidTestOrder();
    await markDelivered(
      db,
      o.id,
      new Date(Date.now() - 5 * 86_400_000),
      "COLLECTED",
    );
    await execSql(
      "UPDATE orders SET status = 'COMPLETED', completed_at = now() WHERE id = $1",
      [o.id],
    );
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: o.buyerName ?? "",
        orderNumber: o.number,
        reason: "DEFECT",
      }),
      { locale: "he", actor: "anonymous" },
    );
    const { result: acc } = await svc.acceptCancellation(admin, result.id);
    expect(acc.returnRequired).toBe(true);
    expect(acc.feeMinor).toBe(0);
    expect(acc.refundId).toBeNull();
    expect(await emailJobs("return-instructions")).toHaveLength(1);
    const built = await buildEmail("return-instructions", result.id, "he");
    expect(built.props.refundAmountMinor).toBe(o.totalMinor);

    await svc.recordReturnReceived(admin, result.id, { tracking: "RR123" });
    await svc.recordInspection(admin, result.id, { damaged: true });
    const { result: r } = await svc.refundCancellation(admin, result.id);
    await executeRefund(r.refundId);
    await settleRefund(r.refundId);
    expect((await order(o.id)).status).toBe("CANCELLED");
    await svc.closeCancellation(admin, result.id);
    const { result: rel } = await svc.relistAfterCancellation(admin, result.id);
    expect(rel.to).toBe("NOT_FOR_SALE");
  });

  it("reject needs a reason and lifts the fulfillment block", async () => {
    const { order: o } = await paidTestOrder();
    const { result } = await svc.recordCancellationNotice(
      notice({ fullName: o.buyerName ?? "", orderNumber: o.number }),
      { locale: "he", actor: "anonymous" },
    );
    expect((await order(o.id)).fulfillmentBlockedReason).toBe(
      "PENDING_CANCELLATION",
    );
    await expect(
      svc.rejectCancellation(admin, result.id, " "),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await svc.rejectCancellation(admin, result.id, "OUTSIDE_WINDOW");
    expect((await cancellation(result.id)).status).toBe("REJECTED");
    expect((await order(o.id)).fulfillmentBlockedReason).toBeNull();
  });

  it("accepting an unmatched notice is refused", async () => {
    const { result } = await svc.recordCancellationNotice(
      notice({ idNumber: { kind: "PASSPORT", value: "AB12345" } }),
      { locale: "he", actor: "anonymous" },
    );
    await expect(
      svc.acceptCancellation(admin, result.id),
    ).rejects.toMatchObject({ code: "NOT_MATCHED" });
  });
});

describe("review payload", () => {
  it("seals and opens the notice; tampering and expiry are rejected", () => {
    const parsed = cancellationNoticeSchema.parse({
      fullName: "Dana Levi",
      idNumber: validIsraeliId(),
      email: "Dana@Example.test",
      eligibleGroup: "",
    });
    const now = new Date("2026-10-01T10:00:00Z");
    const token = sealReview(parsed, "he", now);
    expect(token).not.toContain(parsed.idNumber?.value ?? "x");
    expect(openReview(token, now)?.notice).toEqual(parsed);
    expect(openReview(`${token.slice(0, -2)}AA`, now)).toBeNull();
    expect(
      openReview(token, new Date(now.getTime() + 3 * 60 * 60 * 1000)),
    ).toBeNull();
  });

  it("requires the ID/passport or the order number", () => {
    const r = cancellationNoticeSchema.safeParse({
      fullName: "Dana Levi",
      eligibleGroup: "NONE",
    });
    expect(r.success).toBe(false);
    expect(
      cancellationNoticeSchema.safeParse({
        fullName: "Dana Levi",
        orderNumber: "gg-7k3m9q",
      }).data?.orderNumber,
    ).toBe("GG-7K3M9Q");
  });
});
