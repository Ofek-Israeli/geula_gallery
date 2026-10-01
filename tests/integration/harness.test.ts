import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { artworks, settings } from "@/server/db/schema";
import { cleanDatabaseBeforeEach, testDatabaseUrl } from "../helpers/db";
import { insertArtwork } from "../helpers/factories/core";
import { createMailbox } from "../helpers/mailbox";
import {
  deadlockCount,
  partition,
  race,
  watchLockWaits,
} from "../helpers/race";

/** Sanity checks of the frozen test helpers themselves (spec §9.3). */
cleanDatabaseBeforeEach();

describe("cleanDatabaseBeforeEach", () => {
  it("starts every test with baseline settings and no catalog rows (1/2)", async () => {
    expect(await db.$count(artworks)).toBe(0);
    expect(await db.$count(settings)).toBeGreaterThanOrEqual(4);
    await insertArtwork(db);
  });

  it("starts every test with baseline settings and no catalog rows (2/2)", async () => {
    expect(await db.$count(artworks)).toBe(0);
    await insertArtwork(db);
  });
});

describe("race()", () => {
  it("releases dedicated clients together; row locks serialise them", async () => {
    const art = await insertArtwork(db);
    const before = await deadlockCount();
    const watcher = await watchLockWaits();
    const results = await race(8, async ({ db: own, index }) =>
      own.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM artworks WHERE id = ${art.id} FOR UPDATE`,
        );
        await tx.execute(sql`SELECT pg_sleep(0.02)`);
        await tx.execute(
          sql`UPDATE artworks SET sort_order = sort_order + 1 WHERE id = ${art.id}`,
        );
        return index;
      }),
    );
    const maxWaiters = await watcher.stop();
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    expect(fulfilled.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const [row] = await db
      .select({ n: artworks.sortOrder })
      .from(artworks)
      .where(sql`${artworks.id} = ${art.id}`);
    expect(row?.n).toBe(8);
    expect(maxWaiters).toBeGreaterThanOrEqual(1);
    expect(await deadlockCount()).toBe(before);
  });
});

describe("mailbox", () => {
  it("reads messages stored by the log driver", async () => {
    await db.execute(sql`
      INSERT INTO email_messages (dedupe_key, template, to_email, locale, subject, driver, status, html, text)
      VALUES ('harness:1', 'request-ack', 'Buyer-X@example.test', 'en', 'Hello', 'log', 'SENT', '<p>hi</p>', 'hi')`);
    const mailbox = createMailbox(testDatabaseUrl());
    const [msg] = await mailbox.waitFor({
      to: "buyer-x@example.test",
      template: "request-ack",
    });
    expect(msg?.subject).toBe("Hello");
    expect(await mailbox.list({ to: "nobody@example.test" })).toEqual([]);
  });
});
