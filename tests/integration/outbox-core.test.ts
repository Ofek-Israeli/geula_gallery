import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M1 step 11: the outbox core and the log email driver against real Postgres (TEST_DATABASE_URL).
 * Self-contained until the step-14 harness (globalSetup, truncation helpers) exists.
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI / fresh clone: rely on the shell environment.
}
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) throw new Error("TEST_DATABASE_URL is not set");
if (!["localhost", "127.0.0.1", "::1"].includes(new URL(TEST_DB).hostname)) {
  throw new Error("integration tests only run against a local database");
}

vi.mock("@/server/env", () => ({
  env: {
    APP_ENV: "test",
    APP_URL: "http://localhost:3000",
    APP_SECRET: "test-app-secret-at-least-32-characters-long",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    DEMO_MODE: true,
    EMAIL_DRIVER: "log",
    EMAIL_FROM: "Geula Gallery <studio@example.com>",
    isProduction: false,
  },
}));

const { db, pool } = await import("@/server/db/client");
const { enqueue, enqueueEmail } = await import("@/server/outbox/enqueue");
const { processOutbox } = await import("@/server/outbox/process");
const { sendEmail } = await import("@/server/email/send");
const { createLogEmailSender } = await import("@/server/email/drivers/log");
type Registry = import("@/server/outbox/types").JobHandlerRegistry;

const UUID = "00000000-0000-4000-8000-000000000001";

function handlers(overrides: Partial<Registry>): Registry {
  const done = async () => ({ kind: "done" as const });
  return {
    SEND_EMAIL: done,
    ISSUE_TAX_DOCUMENT: done,
    ISSUE_CREDIT_NOTE: done,
    REFUND_PAYMENT: done,
    REFUND_SETTLED: done,
    ...overrides,
  };
}

async function job(dedupeKey: string) {
  const r = await db.execute<{
    status: string;
    attempts: number;
    run_after: Date;
    last_error: string | null;
    done_at: Date | null;
  }>(
    sql`SELECT status, attempts, run_after, last_error, done_at FROM outbox_jobs WHERE dedupe_key = ${dedupeKey}`,
  );
  return r.rows[0];
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE outbox_jobs, email_messages, admin_alerts RESTART IDENTITY`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("enqueue", () => {
  it("dedupes on the key", async () => {
    const a = await enqueue(db, {
      kind: "REFUND_PAYMENT",
      dedupeKey: `refund:${UUID}`,
      payload: { refundId: UUID },
    });
    const b = await enqueue(db, {
      kind: "REFUND_PAYMENT",
      dedupeKey: `refund:${UUID}`,
      payload: { refundId: UUID },
    });
    expect([a.enqueued, b.enqueued]).toEqual([true, false]);
    const e = await enqueueEmail(db, {
      template: "receipt",
      to: "Buyer@Example.test",
      locale: "en",
      refId: "o1",
    });
    expect(e.enqueued).toBe(true);
    expect((await job("email:receipt:o1:buyer@example.test"))?.status).toBe(
      "PENDING",
    );
  });

  it("rejects payloads that are not ids", async () => {
    await expect(
      enqueue(db, {
        kind: "REFUND_PAYMENT",
        dedupeKey: "x",
        payload: { refundId: "not-a-uuid" },
      }),
    ).rejects.toThrow();
  });
});

describe("processOutbox", () => {
  it("marks DONE, backs off failures and reschedules without using an attempt", async () => {
    for (const k of ["ok", "fail", "later"]) {
      await enqueue(db, {
        kind: "REFUND_PAYMENT",
        dedupeKey: k,
        payload: { refundId: UUID },
      });
    }
    const before = Date.now();
    const stats = await processOutbox({
      limit: 10,
      db,
      handlers: handlers({
        REFUND_PAYMENT: async (_p, ctx) => {
          if (ctx.dedupeKey === "fail") throw new Error("provider down");
          if (ctx.dedupeKey === "later")
            return {
              kind: "reschedule",
              delayMs: 60_000,
              reason: "receipt pending",
            };
          return { kind: "done" };
        },
      }),
    });
    expect(stats).toMatchObject({
      claimed: 3,
      done: 1,
      retried: 1,
      rescheduled: 1,
    });

    const ok = await job("ok");
    expect(ok?.status).toBe("DONE");
    expect(ok?.done_at).not.toBeNull();

    const fail = await job("fail");
    expect(fail?.status).toBe("PENDING");
    expect(fail?.attempts).toBe(1);
    expect(fail?.last_error).toContain("provider down");
    const delay = new Date(fail?.run_after as Date).getTime() - before;
    expect(delay).toBeGreaterThan(110_000);
    expect(delay).toBeLessThan(130_000);

    const later = await job("later");
    expect(later?.status).toBe("PENDING");
    expect(later?.attempts).toBe(0);

    // nothing is due now
    expect(
      (await processOutbox({ limit: 10, db, handlers: handlers({}) })).claimed,
    ).toBe(0);
  });

  it("marks DEAD after 8 attempts and raises one CRITICAL alert", async () => {
    await enqueue(db, {
      kind: "REFUND_SETTLED",
      dedupeKey: "dead",
      payload: { refundId: UUID },
    });
    await db.execute(
      sql`UPDATE outbox_jobs SET attempts = 7 WHERE dedupe_key = 'dead'`,
    );
    const stats = await processOutbox({
      limit: 10,
      db,
      handlers: handlers({
        REFUND_SETTLED: async () => {
          throw new Error("boom");
        },
      }),
    });
    expect(stats.dead).toBe(1);
    expect((await job("dead"))?.status).toBe("DEAD");
    const alerts = await db.execute<{ severity: string; kind: string }>(
      sql`SELECT severity, kind FROM admin_alerts`,
    );
    expect(alerts.rows).toEqual([
      { severity: "CRITICAL", kind: "OUTBOX_JOB_DEAD" },
    ]);
  });

  it("marks an invalid payload DEAD without calling the handler", async () => {
    await db.execute(
      sql`INSERT INTO outbox_jobs (kind, dedupe_key, payload) VALUES ('REFUND_PAYMENT', 'bad', '{"refundId":"x"}')`,
    );
    let called = false;
    await processOutbox({
      limit: 10,
      db,
      handlers: handlers({
        REFUND_PAYMENT: async () => {
          called = true;
          return { kind: "done" };
        },
      }),
    });
    expect(called).toBe(false);
    expect((await job("bad"))?.status).toBe("DEAD");
  });

  it("reclaims a RUNNING job whose lease expired", async () => {
    await enqueue(db, {
      kind: "REFUND_PAYMENT",
      dedupeKey: "crashed",
      payload: { refundId: UUID },
    });
    await db.execute(
      sql`UPDATE outbox_jobs SET status = 'RUNNING', attempts = 1, locked_until = now() - interval '1 minute' WHERE dedupe_key = 'crashed'`,
    );
    const stats = await processOutbox({
      limit: 10,
      db,
      handlers: handlers({}),
    });
    expect(stats.done).toBe(1);
    expect((await job("crashed"))?.attempts).toBe(2);
  });

  it("never runs a job twice under concurrent processors (SKIP LOCKED)", async () => {
    for (let i = 0; i < 12; i++) {
      await enqueue(db, {
        kind: "REFUND_PAYMENT",
        dedupeKey: `c${i}`,
        payload: { refundId: UUID },
      });
    }
    const seen: string[] = [];
    const slow = handlers({
      REFUND_PAYMENT: async (_p, ctx) => {
        seen.push(ctx.dedupeKey);
        await new Promise((r) => setTimeout(r, 20));
        return { kind: "done" };
      },
    });
    const results = await Promise.all([
      processOutbox({ limit: 12, db, handlers: slow }),
      processOutbox({ limit: 12, db, handlers: slow }),
      processOutbox({ limit: 12, db, handlers: slow }),
    ]);
    expect(results.reduce((n, r) => n + r.done, 0)).toBe(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).toHaveLength(12);
  });

  it("hands claimed jobs back when the budget is spent", async () => {
    await enqueue(db, {
      kind: "REFUND_PAYMENT",
      dedupeKey: "budget",
      payload: { refundId: UUID },
    });
    const stats = await processOutbox({
      limit: 10,
      db,
      deadline: Date.now() - 1,
      handlers: handlers({}),
    });
    expect(stats).toMatchObject({ claimed: 1, released: 1, done: 0 });
    const j = await job("budget");
    expect(j?.status).toBe("PENDING");
    expect(j?.attempts).toBe(0);
  });
});

describe("sendEmail with the log driver", () => {
  it("stores html/text, marks SENT and never sends the same key twice", async () => {
    const base = createLogEmailSender();
    let sends = 0;
    const sender = {
      ...base,
      send: async (m: Parameters<typeof base.send>[0]) => {
        sends++;
        return base.send(m);
      },
    };
    const brand = (locale: "he" | "en") => ({
      tradeName: "Geula Gallery",
      address: "Tel Aviv",
      email: "studio@example.com",
      phone: locale === "he" ? "03-000-0000" : "+972-3-000-0000",
      cancelUrl: `http://localhost:3000/${locale}/cancel`,
      siteUrl: `http://localhost:3000/${locale}`,
    });
    const input = {
      dedupeKey: "email:payment-review:o1:buyer@example.test",
      template: "payment-review" as const,
      to: "buyer@example.test",
      locale: "en" as const,
      props: {
        orderNumber: "GG-7K3M9Q",
        buyerName: "Dana",
        orderUrl: "http://localhost:3000/en/orders/GG-7K3M9Q?k=x",
      },
    };
    const first = await sendEmail(input, { db, sender, brand, demo: true });
    const second = await sendEmail(input, { db, sender, brand, demo: true });
    expect(first.status).toBe("sent");
    expect(second).toEqual({
      status: "already_sent",
      emailMessageId: first.emailMessageId,
    });
    expect(sends).toBe(1);
    const rows = await db.execute<{
      status: string;
      driver: string;
      html: string;
      text: string;
      locale: string;
    }>(sql`SELECT status, driver, html, text, locale FROM email_messages`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      status: "SENT",
      driver: "log",
      locale: "en",
    });
    expect(rows.rows[0]?.html).toContain('dir="ltr"');
    expect(rows.rows[0]?.text).toContain("GG-7K3M9Q");
  });
});
