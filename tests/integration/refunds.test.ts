import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { partition, race } from "../helpers/race";

/**
 * Spec §10.3 `refunds`: the cap (counting unconfirmed FAILED rows), concurrent refunds, the
 * IN_FLIGHT lease after a crash (→ UNKNOWN, never a second call), rejected → FAILED with the retry
 * blocked until confirmed, our own refund's webhook arriving before `provider_refund_id`,
 * MANUAL_REQUIRED → MANUAL_DONE, PROVIDER_PENDING, and a failing REFUND_SETTLED job that is retried
 * while the refund row stays final.
 */
const { db } = await import("@/server/db/client");
const { outboxJobs, paymentAttempts, refunds } = await import(
  "@/server/db/schema"
);
const { finalizeAttempt } = await import("@/server/payments/finalize");
const {
  confirmManualRefund,
  confirmRefundFailure,
  executeRefund,
  reconcileRefund,
  requestRefund,
  retryRefund,
  settleRefund,
} = await import("@/server/payments/refunds");
const { syncPostSuccessEvent } = await import("@/server/payments/post-success");
const { mockProviderHooks, resetMockProviderHooks, createMockProvider } =
  await import("@/server/payments/providers/mock");
const { processOutbox } = await import("@/server/outbox/process");
const { outboxHandlers } = await import("@/server/outbox/registry");
const { env } = await import("@/server/env");
const { ConflictError } = await import("@/server/domain/errors");

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

type Admin = import("@/server/domain/admin").AdminContext;
const admin = {
  userId: "u1",
  email: "painter@example.test",
  name: "Painter",
  sessionId: "s1",
  sessionCreatedAt: new Date(),
  twoFactorEnabled: true,
  locale: "he",
  ipHash: null,
  actor: "admin:u1",
} as unknown as Admin;

async function paidOrder() {
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug);
  await clickMockPay(h.ref, "pay");
  const { result } = await finalizeAttempt(h.attemptId, { trigger: "return" });
  expect(result.outcome).toBe("paid");
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, h.attemptId));
  if (!attempt) throw new Error("attempt");
  return { ...h, attempt, total: attempt.amountMinor };
}
async function refund(id: string) {
  const [row] = await db.select().from(refunds).where(eq(refunds.id, id));
  if (!row) throw new Error("refund");
  return row;
}
const pct = (total: number, p: number) => Math.round((total * p) / 100);

describe("refunds", () => {
  it("cap: an unconfirmed FAILED row still counts; a confirmed one does not", async () => {
    const p = await paidOrder();
    const { result: a } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: pct(p.total, 50),
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    mockProviderHooks.refundReject = true;
    expect((await executeRefund(a.refundId)).result.status).toBe("FAILED");
    await expect(
      requestRefund({
        attemptId: p.attemptId,
        amountMinor: pct(p.total, 60),
        reason: "ADMIN",
        requestedBy: "admin:u1",
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_CAPTURED" });
    await confirmRefundFailure(a.refundId, admin);
    const { result: b } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: pct(p.total, 60),
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    expect((await executeRefund(b.refundId)).result.status).toBe("SUCCEEDED");
    await expect(
      requestRefund({
        attemptId: p.attemptId,
        amountMinor: pct(p.total, 41),
        reason: "ADMIN",
        requestedBy: "admin:u1",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("two concurrent 60% refunds: exactly one is accepted", async () => {
    const p = await paidOrder();
    const results = await race(2, (c) =>
      requestRefund(
        {
          attemptId: p.attemptId,
          amountMinor: pct(p.total, 60),
          reason: "ADMIN",
          requestedBy: "admin:u1",
        },
        c.db,
      ),
    );
    const { fulfilled, rejected } = partition(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "REFUND_EXCEEDS_CAPTURED" });
    expect(await db.select().from(refunds)).toHaveLength(1);
  });

  it("a crash after the provider call: the expired lease → UNKNOWN, never a second call", async () => {
    const p = await paidOrder();
    const { result } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: p.total,
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    const row = await refund(result.refundId);
    // The worker claimed the row, called the provider (which refunded), then crashed.
    await execSql(
      "UPDATE refunds SET status = 'IN_FLIGHT', provider_calls = 1, in_flight_until = now() - interval '1 minute' WHERE id = $1",
      [row.id],
    );
    await createMockProvider({ env }).refund({
      refundId: row.id,
      transactionId: p.attempt.transactionId ?? "",
      amount: { amountMinor: row.amountMinor, currency: row.currency },
      isFull: true,
      idemKey: row.idemKey,
      priorRefunds: 0,
      invoiceRef: "x",
      reason: "ADMIN",
    });
    expect(mockProviderHooks.calls.refund).toBe(1);
    expect((await executeRefund(row.id)).result.status).toBe("UNKNOWN");
    expect((await executeRefund(row.id)).result.status).toBe("UNKNOWN");
    expect(mockProviderHooks.calls.refund).toBe(1);
    // Reconcile asks the provider instead of calling refund again.
    expect((await reconcileRefund(row.id)).result.status).toBe("SUCCEEDED");
    expect(mockProviderHooks.calls.refund).toBe(1);
    expect(mockProviderHooks.calls.getRefund).toBe(1);
  });

  it("a timeout without effect → UNKNOWN → reconcile finds nothing → FAILED (still counted)", async () => {
    const p = await paidOrder();
    const { result } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: p.total,
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    mockProviderHooks.refundTimeout = { applied: false };
    expect((await executeRefund(result.refundId)).result.status).toBe(
      "UNKNOWN",
    );
    expect((await reconcileRefund(result.refundId)).result.status).toBe(
      "FAILED",
    );
    await expect(
      requestRefund({
        attemptId: p.attemptId,
        amountMinor: 100,
        reason: "ADMIN",
        requestedBy: "admin:u1",
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_CAPTURED" });
  });

  it("a rejected refund (non-zero code) → FAILED; the retry is blocked until the failure is confirmed", async () => {
    const p = await paidOrder();
    const { result } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: p.total,
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    mockProviderHooks.refundReject = true;
    expect((await executeRefund(result.refundId)).result.status).toBe("FAILED");
    const failed = await refund(result.refundId);
    await expect(
      retryRefund(result.refundId, admin.actor),
    ).rejects.toMatchObject({ code: "FAILURE_NOT_CONFIRMED" });
    await confirmRefundFailure(result.refundId, admin);
    await retryRefund(result.refundId, admin.actor);
    const retried = await refund(result.refundId);
    expect(retried.status).toBe("REQUESTED");
    expect(retried.idemKey).not.toBe(failed.idemKey);
    expect(retried.failureConfirmedAt).toBeNull();
    expect((await executeRefund(result.refundId)).result.status).toBe(
      "SUCCEEDED",
    );
    expect(mockProviderHooks.calls.refund).toBe(2);
  });

  it("our own refund's webhook before provider_refund_id is stored is matched, not EXTERNAL", async () => {
    const p = await paidOrder();
    const { result } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: pct(p.total, 50),
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    await execSql(
      "UPDATE refunds SET status = 'IN_FLIGHT', provider_calls = 1, in_flight_until = now() + interval '2 minutes' WHERE id = $1",
      [result.refundId],
    );
    const sync = await syncPostSuccessEvent({
      kind: "refund",
      attemptId: p.attemptId,
      refundCustomId: result.refundId,
      providerRefundId: "PP-REFUND-1",
      amountMinor: pct(p.total, 50),
      currency: "ILS",
      completed: true,
    });
    expect(sync.result.outcome).toBe("matched");
    const row = await refund(result.refundId);
    expect(row).toMatchObject({
      status: "SUCCEEDED",
      providerRefundId: "PP-REFUND-1",
    });
    const external = await db
      .select()
      .from(refunds)
      .where(
        and(eq(refunds.attemptId, p.attemptId), eq(refunds.reason, "EXTERNAL")),
      );
    expect(external).toHaveLength(0);
    // Matching by amount when the custom id is absent.
    const { result: r2 } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: pct(p.total, 10),
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    await execSql("UPDATE refunds SET status = 'UNKNOWN' WHERE id = $1", [
      r2.refundId,
    ]);
    expect(
      (
        await syncPostSuccessEvent({
          kind: "refund",
          attemptId: p.attemptId,
          providerRefundId: "PP-REFUND-2",
          amountMinor: pct(p.total, 10),
          currency: "ILS",
          completed: true,
        })
      ).result.outcome,
    ).toBe("matched");
    expect((await refund(r2.refundId)).status).toBe("SUCCEEDED");
    // A refund we did not make is recorded as EXTERNAL.
    expect(
      (
        await syncPostSuccessEvent({
          kind: "refund",
          attemptId: p.attemptId,
          providerRefundId: "PP-REFUND-3",
          amountMinor: 500,
          currency: "ILS",
          completed: true,
        })
      ).result.outcome,
    ).toBe("external");
  });

  it("MANUAL_REQUIRED → MANUAL_DONE needs a reference, then settles", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE mock_payments SET amount_minor = amount_minor - 1 WHERE ref = $1",
      [h.ref],
    );
    expect(
      (await finalizeAttempt(h.attemptId, { trigger: "return" })).result
        .outcome,
    ).toBe("needs_refund");
    const [row] = await db.select().from(refunds);
    if (!row) throw new Error("refund");
    expect(row.status).toBe("MANUAL_REQUIRED");
    expect((await executeRefund(row.id)).result.status).toBe("MANUAL_REQUIRED");
    await expect(
      confirmManualRefund(row.id, "  ", admin),
    ).rejects.toMatchObject({ code: "REFERENCE_REQUIRED" });
    await confirmManualRefund(row.id, "DASH-123", admin);
    expect(await refund(row.id)).toMatchObject({
      status: "MANUAL_DONE",
      manualReference: "DASH-123",
    });
    await settleRefund(row.id);
    const [attempt] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    expect(attempt?.status).toBe("REFUNDED");
  });

  it("PROVIDER_PENDING is resolved by reconcile", async () => {
    const p = await paidOrder();
    const { result } = await requestRefund({
      attemptId: p.attemptId,
      amountMinor: p.total,
      reason: "ADMIN",
      requestedBy: "admin:u1",
    });
    mockProviderHooks.refundPending = true;
    expect((await executeRefund(result.refundId)).result.status).toBe(
      "PROVIDER_PENDING",
    );
    expect((await reconcileRefund(result.refundId)).result.status).toBe(
      "SUCCEEDED",
    );
    expect(mockProviderHooks.calls.refund).toBe(1);
  });

  it("a failing REFUND_SETTLED job is retried; the refund row stays final", async () => {
    const art = await buyableArtwork(db);
    const late = await heldOrder(art.slug);
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    const winner = await heldOrder(art.slug);
    await clickMockPay(winner.ref, "pay");
    await finalizeAttempt(winner.attemptId, { trigger: "return" });
    await clickMockPay(late.ref, "pay");
    expect(
      (await finalizeAttempt(late.attemptId, { trigger: "return" })).result
        .outcome,
    ).toBe("needs_refund");

    let failures = 0;
    const handlers = {
      ...outboxHandlers,
      SEND_EMAIL: async () => ({ kind: "done" as const }),
      ISSUE_TAX_DOCUMENT: async () => ({ kind: "done" as const }),
      ISSUE_CREDIT_NOTE: async () => ({ kind: "done" as const }),
      REFUND_SETTLED: async (
        payload: { refundId: string },
        ctx: Parameters<typeof outboxHandlers.REFUND_SETTLED>[1],
      ) => {
        if (failures === 0) {
          failures += 1;
          throw new Error("transient failure");
        }
        return outboxHandlers.REFUND_SETTLED(payload, ctx);
      },
    };
    await processOutbox({ limit: 20, handlers }); // REFUND_PAYMENT runs; REFUND_SETTLED is enqueued
    await processOutbox({ limit: 20, handlers }); // REFUND_SETTLED fails once
    const [row] = await db.select().from(refunds);
    expect(row?.status).toBe("SUCCEEDED");
    const [job] = await db
      .select()
      .from(outboxJobs)
      .where(eq(outboxJobs.kind, "REFUND_SETTLED"));
    expect(job).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(job?.lastError).toContain("transient failure");
    const [stillNeeds] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, late.attemptId));
    expect(stillNeeds?.status).toBe("NEEDS_REFUND");

    await execSql(
      "UPDATE outbox_jobs SET run_after = now() WHERE kind = 'REFUND_SETTLED'",
    );
    await processOutbox({ limit: 20, handlers });
    const [done] = await db
      .select()
      .from(outboxJobs)
      .where(eq(outboxJobs.kind, "REFUND_SETTLED"));
    expect(done?.status).toBe("DONE");
    const [refunded] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, late.attemptId));
    expect(refunded?.status).toBe("REFUNDED");
    expect((await db.select().from(refunds))[0]?.status).toBe("SUCCEEDED");
  });
});
