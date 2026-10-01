import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M1 step 12: `transition()` and `withTx()` against real Postgres (TEST_DATABASE_URL).
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
    isProduction: false,
  },
}));

const { db, pool } = await import("@/server/db/client");
const { buyerRequests } = await import("@/server/db/schema");
const { withTx } = await import("@/server/db/tx");
const { transition } = await import("@/server/domain/transition");
const { IllegalTransitionError } = await import("@/server/domain/errors");

async function newQuestion(): Promise<string> {
  const [row] = await db
    .insert(buyerRequests)
    .values({
      kind: "QUESTION",
      name: "Test Buyer",
      email: "buyer@example.test",
      locale: "en",
      message: "Is it available?",
    })
    .returning({ id: buyerRequests.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE buyer_requests, audit_log RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("transition", () => {
  it("updates the status and patch, and audits in the same transaction", async () => {
    const id = await newQuestion();
    const row = await withTx((tx) =>
      transition(
        tx,
        "buyerRequest",
        id,
        ["NEW"],
        "REPLIED",
        { adminReply: "Yes", repliedAt: new Date() },
        "admin:test",
      ),
    );
    expect(row.status).toBe("REPLIED");
    expect(row.adminReply).toBe("Yes");
    const audit = await db.execute<{
      action: string;
      before: unknown;
      after: unknown;
    }>(
      sql`SELECT action, before, after FROM audit_log WHERE entity_id = ${id}`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.action).toBe("buyerRequest.replied");
    expect(audit.rows[0]?.before).toEqual({ status: "NEW" });
  });

  it("throws IllegalTransitionError when the row is not in allowedFrom", async () => {
    const id = await newQuestion();
    await withTx((tx) =>
      transition(tx, "buyerRequest", id, ["NEW"], "REPLIED", {}, "system"),
    );
    await expect(
      withTx((tx) =>
        transition(tx, "buyerRequest", id, ["NEW"], "REPLIED", {}, "system"),
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    const audit = await db.execute(sql`SELECT 1 FROM audit_log`);
    expect(audit.rows).toHaveLength(1);
  });

  it("refuses edges outside the machine before touching the DB", async () => {
    const id = await newQuestion();
    await expect(
      withTx((tx) =>
        transition(tx, "buyerRequest", id, ["NEW"], "CONVERTED", {}, "system"),
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    const [row] = await db.select().from(buyerRequests);
    expect(row?.status).toBe("NEW");
  });

  it("honours the extra predicate", async () => {
    const id = await newQuestion();
    await expect(
      withTx((tx) =>
        transition(tx, "buyerRequest", id, ["NEW"], "REPLIED", {}, "system", {
          where: sql`${buyerRequests.email} = 'someone-else@example.test'`,
        }),
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("rolls back the transition when the transaction fails", async () => {
    const id = await newQuestion();
    await expect(
      withTx(async (tx) => {
        await transition(
          tx,
          "buyerRequest",
          id,
          ["NEW"],
          "REPLIED",
          {},
          "system",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [row] = await db.select().from(buyerRequests);
    expect(row?.status).toBe("NEW");
    const audit = await db.execute(sql`SELECT 1 FROM audit_log`);
    expect(audit.rows).toHaveLength(0);
  });
});

describe("withTx", () => {
  it("retries serialization failures", async () => {
    let calls = 0;
    const result = await withTx(async () => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error("could not serialize"), {
          code: "40001",
        });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after three attempts and does not retry other errors", async () => {
    let calls = 0;
    await expect(
      withTx(async () => {
        calls++;
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }),
    ).rejects.toThrow("deadlock");
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      withTx(async () => {
        calls++;
        throw Object.assign(new Error("unique"), { code: "23505" });
      }),
    ).rejects.toThrow("unique");
    expect(calls).toBe(1);
  });
});
