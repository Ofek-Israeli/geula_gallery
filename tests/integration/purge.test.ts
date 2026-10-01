import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import { paidTestOrder } from "../helpers/factories/compliance";
import { insertArtwork, insertOrder } from "../helpers/factories/core";

/** Spec §10.3 `purge` (§7 Retention). */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const { runPurge } = await import("@/server/jobs/purge");
const { runCronJob } = await import("@/server/jobs/index");

cleanDatabaseBeforeEach();

describe("purge job", () => {
  it("anonymises never-paid expired orders after 30 days, and only those", async () => {
    const art = await insertArtwork(db);
    const { order: old } = await insertOrder(db, {
      artworks: [art],
      overrides: { status: "EXPIRED" },
    });
    const { order: recent } = await insertOrder(db, {
      artworks: [await insertArtwork(db)],
      overrides: { status: "EXPIRED" },
    });
    const { order: paid } = await paidTestOrder();
    await execSql(
      "UPDATE orders SET updated_at = now() - interval '31 days' WHERE id = ANY($1)",
      [[old.id, paid.id]],
    );
    const stats = await runPurge(db);
    expect(stats.expiredOrders).toBe(1);
    const rows = await db.select().from(schema.orders);
    const by = (id: string) => rows.find((r) => r.id === id);
    expect(by(old.id)).toMatchObject({
      buyerName: null,
      buyerEmail: null,
      buyerPhone: null,
    });
    expect(by(old.id)?.anonymizedAt).not.toBeNull();
    expect(by(old.id)?.accessVersion).toBe(old.accessVersion + 1);
    expect(by(recent.id)?.buyerEmail).not.toBeNull();
    expect(by(paid.id)?.buyerEmail).not.toBeNull();
    // Idempotent.
    expect((await runPurge(db)).expiredOrders).toBe(0);
  });

  it("clears old email bodies, payment payloads, rate limits and old unmatched cancellations", async () => {
    await db.insert(schema.emailMessages).values([
      {
        dedupeKey: "old",
        template: "receipt",
        toEmail: "a@example.test",
        locale: "he",
        subject: "s",
        driver: "log",
        status: "SENT",
        html: "<p>x</p>",
        text: "x",
        createdAt: new Date(Date.now() - 31 * 86_400_000),
      },
      {
        dedupeKey: "new",
        template: "receipt",
        toEmail: "a@example.test",
        locale: "he",
        subject: "s",
        driver: "log",
        status: "SENT",
        html: "<p>y</p>",
        text: "y",
      },
    ]);
    await db.insert(schema.paymentEvents).values({
      provider: "MOCK",
      eventKey: "e1",
      eventType: "x",
      authenticated: true,
      payloadRedacted: { a: 1 },
      receivedAt: new Date(Date.now() - 181 * 86_400_000),
    });
    await db.insert(schema.rateLimits).values([
      {
        key: "k",
        windowStart: new Date(Date.now() - 3 * 86_400_000),
        count: 1,
      },
      { key: "k", windowStart: new Date(), count: 1 },
    ]);
    await db.insert(schema.cancellations).values([
      {
        number: "C-0LD001",
        fullName: "Old",
        orderNumberInput: "GG-000000",
        receivedAt: new Date(Date.now() - 3 * 365 * 86_400_000),
      },
      { number: "C-NEW001", fullName: "New", orderNumberInput: "GG-000001" },
    ]);
    const stats = await runPurge(db);
    expect(stats).toMatchObject({
      emailBodies: 1,
      paymentEventPayloads: 1,
      rateLimits: 1,
      unmatchedCancellations: 1,
    });
    const emails = await db.select().from(schema.emailMessages);
    expect(emails.find((e) => e.dedupeKey === "old")?.html).toBeNull();
    expect(emails.find((e) => e.dedupeKey === "new")?.html).not.toBeNull();
    const left = await db.select().from(schema.cancellations);
    expect(left.map((c) => c.number)).toEqual(["C-NEW001"]);
  });

  it("deletes mock payments of final attempts after 30 days; runs through the cron registry", async () => {
    const { attemptId } = await paidTestOrder();
    await execSql(
      "UPDATE mock_payments SET created_at = now() - interval '31 days' WHERE attempt_id = $1",
      [attemptId],
    );
    const run = await runCronJob("purge", { db });
    expect(run.ok).toBe(true);
    expect(run.stats.mockPayments).toBe(1);
    expect(
      await db
        .select()
        .from(schema.mockPayments)
        .where(eq(schema.mockPayments.attemptId, attemptId)),
    ).toHaveLength(0);
  });
});
