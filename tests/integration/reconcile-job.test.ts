import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { mockWebhookBody, signMockWebhook } from "../helpers/mock-webhook";

/**
 * The `reconcile` cron job (spec §5.11): replays unprocessed webhook events, finalizes attempts
 * whose `next_check_at` is due, resolves refund leases and UNKNOWN refunds by asking the provider,
 * and expires lapsed holds — each step idempotent, recorded in `cron_runs`.
 */
const { db } = await import("@/server/db/client");
const { artworks, cronRuns, orders, paymentAttempts, paymentEvents, refunds } =
  await import("@/server/db/schema");
const { runCronJob } = await import("@/server/jobs");
const { handlePaymentWebhook } = await import("@/server/payments/webhook");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { requestRefund, executeRefund } = await import(
  "@/server/payments/refunds"
);
const { mockProviderHooks, resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);

cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

async function orderOf(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}

async function reconcile() {
  const run = await runCronJob("reconcile");
  expect(run.ok).toBe(true);
  return run.stats as {
    events: { processed: number; failed: number };
    attempts: { processed: number; outcomes: Record<string, number> };
    refunds: { leasesExpired: number; statuses: Record<string, number> };
    ordersExpired: number;
  };
}

describe("reconcile job", () => {
  it("replays a webhook event whose processing failed", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    mockProviderHooks.fetchTimeout = true;
    const raw = mockWebhookBody(h.ref);
    const res = await handlePaymentWebhook({
      provider: "mock",
      headers: new Headers({
        "x-mock-signature": signMockWebhook(
          raw,
          process.env.MOCK_WEBHOOK_SECRET ?? "",
        ),
      }),
      rawBody: raw,
      query: new URLSearchParams(),
      ip: "203.0.113.5",
    });
    expect(res.status).toBe(500);
    // Too fresh for a replay (< 2 min) and the attempt's own check is due now: make the event old
    // and the attempt not yet due, so this test exercises step 1 alone.
    await execSql(
      "UPDATE payment_events SET received_at = now() - interval '3 minutes'",
    );
    await execSql(
      "UPDATE payment_attempts SET next_check_at = now() + interval '1 hour' WHERE id = $1",
      [h.attemptId],
    );
    const stats = await reconcile();
    expect(stats.events.processed).toBe(1);
    expect((await orderOf(h.orderId))?.status).toBe("PAID");
    const [event] = await db.select().from(paymentEvents);
    expect(event?.processedAt).toBeInstanceOf(Date);
  });

  it("finalizes an attempt the buyer paid without returning and no webhook arrived", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    // Not due yet: nothing happens.
    expect((await reconcile()).attempts.processed).toBe(0);
    await execSql(
      "UPDATE payment_attempts SET next_check_at = now() - interval '1 second' WHERE id = $1",
      [h.attemptId],
    );
    const stats = await reconcile();
    expect(stats.attempts.outcomes).toEqual({ paid: 1 });
    expect((await orderOf(h.orderId))?.status).toBe("PAID");
    // Idempotent: the next pass has nothing to do.
    expect((await reconcile()).attempts.processed).toBe(0);
  });

  it("an unpaid attempt is checked again later (backoff), not finalized", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await execSql(
      "UPDATE payment_attempts SET next_check_at = now() - interval '1 second' WHERE id = $1",
      [h.attemptId],
    );
    const stats = await reconcile();
    expect(stats.attempts.outcomes).toEqual({ pending: 1 });
    const [a] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    expect(a?.status).toBe("PENDING");
    expect(a?.nextCheckAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("expires a lapsed hold and frees the work", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    await execSql(
      "UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [h.orderId],
    );
    await execSql(
      "UPDATE payment_attempts SET next_check_at = now() + interval '1 hour' WHERE id = $1",
      [h.attemptId],
    );
    const stats = await reconcile();
    expect(stats.ordersExpired).toBe(1);
    expect((await orderOf(h.orderId))?.status).toBe("EXPIRED");
    const [a] = await db.select().from(artworks).where(eq(artworks.id, art.id));
    expect(a?.reservedByOrderId).toBeNull();
  });

  it("resolves an UNKNOWN refund by asking the provider (no second refund call)", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await finalizeAttempt(h.attemptId, { trigger: "return" });
    const [a] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    const { result } = await requestRefund({
      attemptId: h.attemptId,
      amountMinor: a?.amountMinor ?? 0,
      reason: "ADMIN",
      requestedBy: "admin:test",
    });
    mockProviderHooks.refundTimeout = { applied: true };
    expect((await executeRefund(result.refundId)).result.status).toBe(
      "UNKNOWN",
    );
    const stats = await reconcile();
    expect(stats.refunds.statuses).toEqual({ SUCCEEDED: 1 });
    const [r] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, result.refundId));
    expect(r?.status).toBe("SUCCEEDED");
    expect(mockProviderHooks.calls.refund).toBe(1);
  });

  it("turns an expired IN_FLIGHT lease into UNKNOWN", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await finalizeAttempt(h.attemptId, { trigger: "return" });
    const [a] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    const { result } = await requestRefund({
      attemptId: h.attemptId,
      amountMinor: a?.amountMinor ?? 0,
      reason: "ADMIN",
      requestedBy: "admin:test",
    });
    await execSql(
      "UPDATE refunds SET status = 'IN_FLIGHT', provider_calls = 1, in_flight_until = now() - interval '1 second' WHERE id = $1",
      [result.refundId],
    );
    const stats = await reconcile();
    expect(stats.refunds.leasesExpired).toBe(1);
    // The same pass then asks the provider; the mock never received the call → FAILED.
    const [r] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, result.refundId));
    expect(["UNKNOWN", "FAILED"]).toContain(r?.status);
    expect(mockProviderHooks.calls.refund).toBe(0);
  });

  it("records a cron_runs row and stops starting work when the budget is spent", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE payment_attempts SET next_check_at = now() - interval '1 second' WHERE id = $1",
      [h.attemptId],
    );
    const run = await runCronJob("reconcile", { budgetMs: 0 });
    expect(run.ok).toBe(true);
    expect((await orderOf(h.orderId))?.status).toBe("AWAITING_PAYMENT");
    const rows = await db.select().from(cronRuns);
    expect(rows.at(-1)).toMatchObject({ job: "reconcile", ok: true });
  });
});
