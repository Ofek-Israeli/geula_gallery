import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { catalogSeed } from "../../scripts/seed/catalog";
import { ordersSeed } from "../../scripts/seed/orders";
import { settingsSeed } from "../../scripts/seed/settings";
import type { SeedContext } from "../../scripts/seed/types";
import { resetDatabase } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import { paidTestOrder } from "../helpers/factories/compliance";
import { insertArtwork } from "../helpers/factories/core";

/**
 * Spec §10.3 `invariants` (§3.4 layer 6): the demo seed (catalog + the three sample orders) is
 * consistent; a real purchase is consistent once its receipt is issued; each check catches a
 * deliberately broken row.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const { checkInvariants } = await import("@/server/invariants");
const { processOutbox } = await import("@/server/outbox/process");
const { goLiveBlockers } = await import("@/server/golive");

const ctx: SeedContext = {
  db: db as unknown as SeedContext["db"],
  mode: "demo",
  env: {
    authBaseUrl: "http://localhost:3000",
    seedE2eUsers: false,
    e2eAdminPassword: "e2e-admin-password",
    storageDriver: "local",
    storageDir: ".data/test-uploads",
  },
  log: () => {},
};

beforeAll(async () => {
  await resetDatabase();
  await settingsSeed.run(ctx);
  await catalogSeed.run(ctx);
  await ordersSeed.run(ctx);
}, 120_000);

const checks = async () =>
  (await checkInvariants({ db, graceMinutes: 0 })).violations.map(
    (v) => `${v.check}:${v.id}`,
  );

describe("checkInvariants", () => {
  it("the demo seed is consistent (sample orders, sales, receipts, holds)", async () => {
    expect(await checks()).toEqual([]);
    const orders = await db.select().from(schema.orders);
    expect(orders.map((o) => o.number).sort()).toEqual([
      "GG-SAMP01",
      "GG-SAMP02",
      "GG-SAMP03",
    ]);
    const [c] = await db.select().from(schema.cancellations);
    expect(c?.status).toBe("RECEIVED");
    expect(c?.refundDueAt && c.refundDueAt > new Date()).toBe(true);
    // Seeds never enqueue outbox jobs.
    expect(await db.$count(schema.outboxJobs)).toBe(0);
  });

  it("a purchase is consistent once its receipt exists", async () => {
    const { attemptId } = await paidTestOrder();
    expect(await checks()).toContain(
      `captured_attempt_has_receipt:${attemptId}`,
    );
    for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
    expect(await checks()).toEqual([]);
  });

  it("catches a SOLD work without a sale and a second active sale", async () => {
    const art = await insertArtwork(db, {
      saleStatus: "SOLD",
      soldAt: new Date(),
    });
    expect(await checks()).toContain(`sold_has_one_sale:${art.id}`);
    await execSql(
      "UPDATE artworks SET sale_status = 'AVAILABLE' WHERE id = $1",
      [art.id],
    );
  });

  it("catches a live hold on a closed order, a paid order without a bound attempt, an over-refund and a missing credit note", async () => {
    const { order, attemptId, artwork } = await paidTestOrder();
    for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
    expect(await checks()).toEqual([]);

    // Unbound attempt (amount differs from the order total).
    await execSql(
      "UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1",
      [attemptId],
    );
    expect(await checks()).toContain(
      `paid_order_one_succeeded_attempt:${order.id}`,
    );
    await execSql(
      "UPDATE payment_attempts SET amount_minor = amount_minor - 1 WHERE id = $1",
      [attemptId],
    );

    // A refund row larger than the capture, settled, with no credit note.
    const [r] = await db
      .insert(schema.refunds)
      .values({
        attemptId,
        orderId: order.id,
        amountMinor: order.totalMinor + 100,
        currency: order.currency,
        reason: "ADMIN",
        status: "SUCCEEDED",
        idemKey: crypto.randomUUID(),
        requestedBy: "test",
        completedAt: new Date(Date.now() - 3_600_000),
      })
      .returning();
    const found = await checks();
    expect(found).toContain(`refunds_within_capture:${attemptId}`);
    expect(found).toContain(`settled_refund_has_credit_note:${r?.id}`);
    await db.delete(schema.refunds).where(eq(schema.refunds.id, r?.id ?? ""));

    // A live hold that points at a PAID order.
    const other = await insertArtwork(db);
    await execSql(
      "UPDATE artworks SET reserved_by_order_id = $1, reserved_until = now() + interval '10 minutes' WHERE id = $2",
      [order.id, other.id],
    );
    expect(await checks()).toContain(`hold_belongs_to_open_order:${other.id}`);
    await execSql(
      "UPDATE artworks SET reserved_by_order_id = NULL, reserved_until = NULL WHERE id = $1",
      [other.id],
    );
    expect(await checks()).toEqual([]);
    expect(artwork.id).toBeTruthy();
  });
});

describe("goLiveBlockers", () => {
  it("lists the demo-mode blockers", async () => {
    const r = await goLiveBlockers({ db });
    expect(r.ok).toBe(false);
    for (const b of [
      "DEMO_MODE",
      "PROFILE_INCOMPLETE",
      "LEGAL_NOT_APPROVED",
      "RATES_UNCALIBRATED",
      "INSURANCE_UNCONFIRMED",
      "DEMO_WORKS_PUBLISHED",
      "CARDCOM_NOT_LIVE",
    ]) {
      expect(r.blockers).toContain(b);
    }
  });
});
