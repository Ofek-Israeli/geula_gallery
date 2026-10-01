import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { adminCtx, insertRequest } from "../helpers/factories/admin";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";

/**
 * Admin order actions (spec §5.7 step 8, §6.10 `/admin/orders/[id]`): the admin refund under the
 * cap, MANUAL_REQUIRED → MANUAL_DONE, UNKNOWN resolved from the provider dashboard, FAILED tax
 * documents retried and NEEDS_MANUAL ones recorded, unpaid orders released, and the dashboard
 * cards that point at them.
 */
const { db } = await import("@/server/db/client");
const { orders, outboxJobs, refunds, taxDocuments } = await import(
  "@/server/db/schema"
);
const admin = await import("@/server/orders/admin");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { processOutbox } = await import("@/server/outbox/process");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { resetMockTaxDocHooks } = await import("@/server/taxdocs/mock");
const { getDashboard, navBadges } = await import("@/server/admin/dashboard");

const ctx = adminCtx();
cleanDatabaseBeforeEach();
beforeEach(() => {
  resetMockProviderHooks();
  resetMockTaxDocHooks({ forget: true });
});

async function paid() {
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug);
  await clickMockPay(h.ref, "pay");
  await finalizeAttempt(h.attemptId, { trigger: "return" });
  return h;
}

async function drain() {
  for (let i = 0; i < 4; i++) await processOutbox({ limit: 50 });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return "ok";
}

describe("admin refund", () => {
  it("refunds under the cap and the refund settles; the cap refuses more", async () => {
    const h = await paid();
    const detail = await admin.getAdminOrder(ctx, h.orderId);
    if (!detail) throw new Error("no order");
    const cap = admin.refundableByAttempt(detail.attempts, detail.refunds);
    expect(cap[h.attemptId]).toBe(detail.order.totalMinor);
    const { result } = await admin.adminRefund(ctx, {
      attemptId: h.attemptId,
      amountMinor: 50_000,
      note: "goodwill",
    });
    await drain();
    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, result.refundId));
    expect(row).toMatchObject({
      status: "SUCCEEDED",
      reason: "ADMIN",
      requestedBy: ctx.actor,
    });
    expect(
      await code(
        admin.adminRefund(ctx, {
          attemptId: h.attemptId,
          amountMinor: detail.order.totalMinor,
          note: null,
        }),
      ),
    ).toBe("REFUND_EXCEEDS_CAPTURED");
  });

  it("UNKNOWN: 'refunded' needs a reference and settles; 'not refunded' confirms the failure", async () => {
    const h = await paid();
    const a = await admin.adminRefund(ctx, {
      attemptId: h.attemptId,
      amountMinor: 10_000,
      note: null,
    });
    const b = await admin.adminRefund(ctx, {
      attemptId: h.attemptId,
      amountMinor: 10_000,
      note: null,
    });
    await execSql("UPDATE refunds SET status = 'UNKNOWN' WHERE order_id = $1", [
      h.orderId,
    ]);
    expect(
      await code(
        admin.resolveUnknownRefund(ctx, a.result.refundId, {
          outcome: "refunded",
          reference: " ",
        }),
      ),
    ).toBe("REFERENCE_REQUIRED");
    await admin.resolveUnknownRefund(ctx, a.result.refundId, {
      outcome: "refunded",
      reference: "RF-123",
    });
    await admin.resolveUnknownRefund(ctx, b.result.refundId, {
      outcome: "not_refunded",
      reference: null,
    });
    const rows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, h.orderId));
    const ra = rows.find((r) => r.id === a.result.refundId);
    const rb = rows.find((r) => r.id === b.result.refundId);
    expect(ra).toMatchObject({
      status: "SUCCEEDED",
      manualReference: "RF-123",
    });
    expect(rb?.status).toBe("FAILED");
    expect(rb?.failureConfirmedAt).not.toBeNull();
    const [settled] = await db
      .select()
      .from(outboxJobs)
      .where(eq(outboxJobs.dedupeKey, `refund-settled:${a.result.refundId}`));
    expect(settled).toBeDefined();
    // The confirmed failure can be retried.
    await admin.retryFailedRefund(ctx, b.result.refundId);
    const [again] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, b.result.refundId));
    expect(again?.status).toBe("REQUESTED");
  });

  it("MANUAL_REQUIRED → MANUAL_DONE with a reference", async () => {
    const h = await paid();
    const { result } = await admin.adminRefund(ctx, {
      attemptId: h.attemptId,
      amountMinor: 5_000,
      note: null,
    });
    await execSql(
      "UPDATE refunds SET status = 'MANUAL_REQUIRED' WHERE id = $1",
      [result.refundId],
    );
    expect(await code(admin.markRefundDone(ctx, result.refundId, ""))).toBe(
      "REFERENCE_REQUIRED",
    );
    await admin.markRefundDone(ctx, result.refundId, "bank 42");
    const [row] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, result.refundId));
    expect(row).toMatchObject({
      status: "MANUAL_DONE",
      manualReference: "bank 42",
    });
  });
});

describe("tax documents", () => {
  it("a FAILED receipt is retried and issued; NEEDS_MANUAL is recorded by hand", async () => {
    const h = await paid();
    await drain();
    const [doc] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.orderId, h.orderId));
    if (!doc) throw new Error("no receipt");
    expect(doc.status).toBe("ISSUED");
    await execSql(
      "UPDATE tax_documents SET status = 'FAILED', doc_number = NULL, provider_doc_id = NULL, issued_at = NULL, error = 'rejected' WHERE id = $1",
      [doc.id],
    );
    resetMockTaxDocHooks({ forget: true });
    await admin.retryTaxDocument(ctx, doc.id);
    let [row] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.id, doc.id));
    expect(row).toMatchObject({ status: "ISSUING", attempts: 0, error: null });
    await drain();
    [row] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.id, doc.id));
    expect(row?.status).toBe("ISSUED");
    expect(await code(admin.retryTaxDocument(ctx, doc.id))).toBe("NOT_FAILED");

    await execSql(
      "UPDATE tax_documents SET status = 'NEEDS_MANUAL' WHERE id = $1",
      [doc.id],
    );
    await admin.recordManualTaxDocument(ctx, doc.id, "R-7788");
    [row] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.id, doc.id));
    expect(row).toMatchObject({ status: "ISSUED", docNumber: "R-7788" });
  });
});

describe("unpaid orders and the dashboard", () => {
  it("cancelling an unpaid order releases the work", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await admin.cancelUnpaidOrder(ctx, h.orderId);
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    expect(order).toMatchObject({ status: "EXPIRED", statusReason: "ADMIN" });
  });

  it("cards count refunds needing the admin, orders to fulfil and open requests", async () => {
    const h = await paid();
    const { result } = await admin.adminRefund(ctx, {
      attemptId: h.attemptId,
      amountMinor: 1_000,
      note: null,
    });
    await execSql(
      "UPDATE refunds SET status = 'MANUAL_REQUIRED', legal_due_at = now() + interval '1 day' WHERE id = $1",
      [result.refundId],
    );
    await insertRequest(db);
    const d = await getDashboard(ctx);
    const card = (k: string) => d.cards.find((c) => c.key === k);
    expect(card("refundProblems")?.count).toBe(1);
    expect(card("refundsDue")?.count).toBe(1);
    expect(card("refundsDue")?.severity).toBe("critical");
    expect(card("toFulfil")?.count).toBe(1);
    expect(card("openRequests")?.count).toBe(1);
    // Demo works and mock sales are not turnover.
    expect(d.turnover.totalIlsMinor).toBe(0);
    expect(d.turnover.ceilingIlsMinor).toBe(12_283_300);
    const badges = await navBadges(ctx);
    expect(badges).toMatchObject({ inbox: 1, orders: 1 });
  });
});
