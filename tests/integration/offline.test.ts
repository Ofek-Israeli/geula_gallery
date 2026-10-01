import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
  linkOrder,
  testAdminContext,
} from "../helpers/factories/commerce";

/**
 * `recordOfflinePayment` (spec §4.2, §5.10, §10.3 `offline`): a fresh session, the exact order total
 * in the order currency, an OFFLINE / MANUAL attempt bound to the quote version and applied like an
 * online payment; a payment that can no longer be applied is routed to a MANUAL_REQUIRED refund.
 */
const { db } = await import("@/server/db/client");
const {
  artworks,
  orders,
  outboxJobs,
  paymentAttempts,
  refunds,
  sales,
  taxDocuments,
} = await import("@/server/db/schema");
const { recordOfflinePayment } = await import("@/server/payments/offline");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { processOutbox } = await import("@/server/outbox/process");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { resetMockTaxDocHooks } = await import("@/server/taxdocs/mock");

cleanDatabaseBeforeEach();
beforeEach(() => {
  resetMockProviderHooks();
  resetMockTaxDocHooks({ forget: true });
});

const ctx = testAdminContext();

async function orderOf(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("no order");
  return row;
}

async function manualOrder() {
  const art = await buyableArtwork(db);
  const link = await linkOrder(art);
  return { art, order: await orderOf(link.orderId) };
}

describe("recordOfflinePayment", () => {
  it("an exact transfer pays the order: SOLD, sale, receipt job with the transfer type", async () => {
    const { art, order } = await manualOrder();
    const receivedAt = new Date(Date.now() - 2 * 60 * 60_000);
    const { result, effects } = await recordOfflinePayment(
      order.id,
      {
        method: "transfer",
        amountMinor: order.totalMinor,
        currency: "ILS",
        reference: "Bank ref 4471",
        receivedAt,
      },
      ctx,
    );
    expect(result.outcome).toBe("paid");
    expect(effects.outbox).toBe(true);

    const paid = await orderOf(order.id);
    expect(paid).toMatchObject({
      status: "PAID",
      paidAttemptId: result.attemptId,
    });
    expect(paid.paidAt?.getTime()).toBe(receivedAt.getTime());
    const [attempt] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, result.attemptId));
    expect(attempt).toMatchObject({
      provider: "OFFLINE",
      providerMode: "MANUAL",
      status: "SUCCEEDED",
      quoteVersion: order.quoteVersion,
      amountMinor: order.totalMinor,
      method: "transfer",
      transactionId: "Bank ref 4471",
    });
    const [art2] = await db
      .select()
      .from(artworks)
      .where(eq(artworks.id, art.id));
    expect(art2?.saleStatus).toBe("SOLD");
    expect(
      await db.select().from(sales).where(eq(sales.orderId, order.id)),
    ).toHaveLength(1);

    const jobs = await db
      .select({ key: outboxJobs.dedupeKey })
      .from(outboxJobs);
    const keys = jobs.map((j) => j.key);
    expect(keys).toContain(`taxdoc:receipt:${result.attemptId}`);
    expect(keys.some((k) => k.startsWith("email:order-confirmation:"))).toBe(
      true,
    );
    for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
    const [doc] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.attemptId, result.attemptId));
    expect(doc?.status).toBe("ISSUED");
    // A second recording is refused: the order is paid.
    await expect(
      recordOfflinePayment(
        order.id,
        {
          method: "transfer",
          amountMinor: order.totalMinor,
          currency: "ILS",
          reference: "again",
          receivedAt,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PAYABLE" });
    // finalize leaves an offline attempt alone.
    const again = await finalizeAttempt(result.attemptId, { trigger: "admin" });
    expect(again.result.outcome).toBe("already_final");
  });

  it("refuses a different amount or currency, a stale session and a reference-less transfer", async () => {
    const { order } = await manualOrder();
    const base = {
      method: "transfer" as const,
      amountMinor: order.totalMinor,
      currency: "ILS" as const,
      reference: "ref",
      receivedAt: new Date(),
    };
    await expect(
      recordOfflinePayment(
        order.id,
        { ...base, amountMinor: order.totalMinor - 100 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    await expect(
      recordOfflinePayment(order.id, { ...base, currency: "USD" }, ctx),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    await expect(
      recordOfflinePayment(
        order.id,
        base,
        testAdminContext({
          sessionCreatedAt: new Date(Date.now() - 31 * 60_000),
        }),
      ),
    ).rejects.toMatchObject({ code: "FRESH_SESSION_REQUIRED" });
    await expect(
      recordOfflinePayment(order.id, { ...base, reference: " " }, ctx),
    ).rejects.toMatchObject({ code: "REFERENCE" });
    await expect(
      recordOfflinePayment(
        order.id,
        { ...base, receivedAt: new Date(Date.now() + 60 * 60_000) },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "RECEIVED_AT" });
    // Cash needs no reference.
    const { result } = await recordOfflinePayment(
      order.id,
      { ...base, method: "cash", reference: "" },
      ctx,
    );
    expect(result.outcome).toBe("paid");
    expect((await orderOf(order.id)).status).toBe("PAID");
    expect(await db.select().from(paymentAttempts)).toHaveLength(1);
  });

  it("is refused while an online payment of the order is being confirmed", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "review");
    await finalizeAttempt(h.attemptId, { trigger: "return" });
    const order = await orderOf(h.orderId);
    expect(order.status).toBe("PAYMENT_REVIEW");
    await expect(
      recordOfflinePayment(
        order.id,
        {
          method: "transfer",
          amountMinor: order.totalMinor,
          currency: "ILS",
          reference: "r",
          receivedAt: new Date(),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PAYABLE" });
  });

  it("a late payment for an expired order whose work is still free → PAID", async () => {
    const { art, order } = await manualOrder();
    await execSql(
      `UPDATE artworks SET reserved_by_order_id = NULL, reserved_until = NULL WHERE id = $1`,
      [art.id],
    );
    await execSql(
      `UPDATE orders SET status = 'EXPIRED', status_reason = 'LINK_EXPIRED' WHERE id = $1`,
      [order.id],
    );
    const { result } = await recordOfflinePayment(
      order.id,
      {
        method: "cheque",
        amountMinor: order.totalMinor,
        currency: "ILS",
        reference: "Cheque 0012",
        receivedAt: new Date(),
      },
      ctx,
    );
    expect(result.outcome).toBe("paid");
    expect((await orderOf(order.id)).status).toBe("PAID");
  });

  it("a payment for an expired order whose work was sold → MANUAL_REQUIRED refund, no provider job", async () => {
    const { art, order } = await manualOrder();
    await execSql(
      `UPDATE artworks SET reserved_by_order_id = NULL, reserved_until = NULL WHERE id = $1`,
      [art.id],
    );
    await execSql(
      `UPDATE orders SET status = 'EXPIRED', status_reason = 'LINK_EXPIRED' WHERE id = $1`,
      [order.id],
    );
    // Someone else bought it on the web meanwhile.
    const web = await heldOrder(art.slug);
    await clickMockPay(web.ref, "pay");
    await finalizeAttempt(web.attemptId, { trigger: "return" });

    const { result } = await recordOfflinePayment(
      order.id,
      {
        method: "transfer",
        amountMinor: order.totalMinor,
        currency: "ILS",
        reference: "Bank ref 9",
        receivedAt: new Date(),
      },
      ctx,
    );
    expect(result.outcome).toBe("needs_refund");
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, result.attemptId));
    expect(refund).toMatchObject({
      reason: "LOST_RESERVATION",
      status: "MANUAL_REQUIRED",
      amountMinor: order.totalMinor,
    });
    const jobs = await db
      .select({ key: outboxJobs.dedupeKey })
      .from(outboxJobs);
    expect(jobs.some((j) => j.key === `refund:${refund?.id}`)).toBe(false);
    expect((await orderOf(order.id)).status).toBe("CANCELLED");
  });
});
