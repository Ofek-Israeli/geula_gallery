import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  checkoutInput,
  execSql,
  heldOrder,
  patchSetting,
  startTestCheckout,
} from "../helpers/factories/commerce";
import { insertOrder, uniqueBuyer } from "../helpers/factories/core";
import {
  deadlockCount,
  partition,
  race,
  watchLockWaits,
} from "../helpers/race";

/**
 * Spec §10.3 `reserve-race`: one hold per work under real concurrency (20 dedicated connections
 * released by a barrier), takeover of expired holds, all-or-nothing reservation, the
 * anti-hoarding caps under advisory locks, the per-artwork budget, cooldown and hold span, and
 * the double-submit resume.
 */
const { db } = await import("@/server/db/client");
const { artworks, orders } = await import("@/server/db/schema");
const { startCheckout, startPaymentForOrder } = await import(
  "@/server/checkout/start"
);
const { withTx } = await import("@/server/db/tx");
const { allReservable, lockArtworks, reserveArtworks } = await import(
  "@/server/checkout/reservations"
);
const { expireStaleOrders, releaseReservation } = await import(
  "@/server/checkout/release"
);

cleanDatabaseBeforeEach();

async function artworkRow(id: string) {
  const [row] = await db.select().from(artworks).where(eq(artworks.id, id));
  if (!row) throw new Error("artwork missing");
  return row;
}

async function orderRow(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error("order missing");
  return row;
}

describe("reserve race", () => {
  it("20 buyers released together: exactly one hold, no deadlock, lock waits observed", async () => {
    const art = await buyableArtwork(db);
    const inputs = await Promise.all(
      Array.from({ length: 20 }, () => checkoutInput(art.slug)),
    );
    const deadlocksBefore = await deadlockCount();
    const watcher = await watchLockWaits(1);
    const results = await race(20, (c) =>
      startCheckout(inputs[c.index] as (typeof inputs)[number], { db: c.db }),
    );
    const maxWaiters = await watcher.stop();
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    const kinds = fulfilled.map((r) => r.result.kind);
    expect(kinds.filter((k) => k === "redirect")).toHaveLength(1);
    expect(kinds.filter((k) => k === "just_reserved")).toHaveLength(19);
    expect(await deadlockCount()).toBe(deadlocksBefore);
    expect(maxWaiters).toBeGreaterThanOrEqual(1);

    const winner = fulfilled.find((r) => r.result.kind === "redirect");
    const a = await artworkRow(art.id);
    expect(a.reservedByOrderId).toBe(
      winner?.result.kind === "redirect" ? winner.result.orderId : "x",
    );
    const all = await db.select().from(orders);
    expect(all).toHaveLength(1);
  });

  it("takes over an expired hold and expires the old order (HOLD_TAKEN_OVER)", async () => {
    const art = await buyableArtwork(db);
    const first = await heldOrder(art.slug);
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    const second = await heldOrder(art.slug);
    expect((await artworkRow(art.id)).reservedByOrderId).toBe(second.orderId);
    const old = await orderRow(first.orderId);
    expect(old.status).toBe("EXPIRED");
    expect(old.statusReason).toBe("HOLD_TAKEN_OVER");
  });

  it("never takes over an expired hold while its payment is in flight", async () => {
    const art = await buyableArtwork(db);
    const late = await checkoutInput(art.slug);
    const first = await heldOrder(art.slug);
    await execSql(
      "UPDATE payment_attempts SET status = 'CAPTURING', capture_request_id = gen_random_uuid(), capturing_since = now() WHERE id = $1",
      [first.attemptId],
    );
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    const { result } = await startCheckout(late);
    expect(result.kind).toBe("just_reserved");
    expect((await artworkRow(art.id)).reservedByOrderId).toBe(first.orderId);
    // The lock-level predicate agrees with the quote: the hold is not reservable.
    const reservable = await withTx(async (tx) => {
      const locked = await lockArtworks(tx, [art.id]);
      return allReservable(tx, locked, null, true, new Date());
    });
    expect(reservable).toBe(false);
  });

  it("reserves two works all or nothing", async () => {
    const a1 = await buyableArtwork(db);
    const a2 = await buyableArtwork(db);
    const { order: holder } = await insertOrder(db, { artworks: [a2] });
    await db
      .update(artworks)
      .set({
        reservedByOrderId: holder.id,
        reservedUntil: new Date(Date.now() + 30 * 60_000),
      })
      .where(eq(artworks.id, a2.id));
    const { order: mine } = await insertOrder(db, { artworks: [a1, a2] });
    const ok = await withTx(async (tx) => {
      await lockArtworks(tx, [a1.id, a2.id]);
      const reserved = await reserveArtworks(tx, {
        artworkIds: [a1.id, a2.id],
        orderId: mine.id,
        until: new Date(Date.now() + 35 * 60_000),
        web: true,
      });
      if (!reserved) throw new Error("rollback");
      return reserved;
    }).catch(() => false);
    expect(ok).toBe(false);
    const rows = await db
      .select()
      .from(artworks)
      .where(inArray(artworks.id, [a1.id, a2.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a1.id)?.reservedByOrderId).toBeNull();
    expect(byId.get(a2.id)?.reservedByOrderId).toBe(holder.id);
  });

  it("caps live holds per email under advisory locks, even when started together", async () => {
    const works = await Promise.all([1, 2, 3].map(() => buyableArtwork(db)));
    const buyer = uniqueBuyer();
    const inputs = await Promise.all(
      works.map((w, i) =>
        checkoutInput(w.slug, { buyer, ipHash: `ip-${i}-${randomUUID()}` }),
      ),
    );
    const results = await race(3, (c) =>
      startCheckout(inputs[c.index] as (typeof inputs)[number], { db: c.db }),
    );
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    const kinds = fulfilled.map((r) => r.result);
    expect(kinds.filter((k) => k.kind === "redirect")).toHaveLength(2);
    expect(kinds.filter((k) => k.kind === "refused")).toEqual([
      { kind: "refused", code: "too_many_holds" },
    ]);
  });

  it("caps live holds per IP hash", async () => {
    const works = await Promise.all([1, 2, 3, 4].map(() => buyableArtwork(db)));
    const ipHash = `ip-${randomUUID()}`;
    const out: string[] = [];
    for (const w of works) {
      const { result } = await startTestCheckout(w.slug, { ipHash });
      out.push(result.kind === "refused" ? result.code : result.kind);
    }
    expect(out).toEqual(["redirect", "redirect", "redirect", "too_many_holds"]);
  });

  it("enforces the cooldown after a lapsed hold and the per-artwork 24 h budget", async () => {
    const art = await buyableArtwork(db);
    const buyer = uniqueBuyer();
    const ipHash = `ip-${randomUUID()}`;
    const first = await heldOrder(art.slug, { buyer, ipHash });
    // The hold lapses and the expiry job runs.
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    await execSql(
      "UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [first.orderId],
    );
    const { result: expired } = await expireStaleOrders({
      limit: 10,
      deadline: Date.now() + 10_000,
    });
    expect(expired.expired).toBe(1);
    const cooling = await startTestCheckout(art.slug, { buyer, ipHash });
    expect(cooling.result).toEqual({ kind: "refused", code: "hold_cooldown" });

    // After the cooldown, a second hold is allowed, the third in 24 h is not.
    await execSql(
      "UPDATE orders SET expires_at = now() - interval '20 minutes' WHERE id = $1",
      [first.orderId],
    );
    const second = await heldOrder(art.slug, { buyer, ipHash });
    await releaseReservation({
      orderId: second.orderId,
      actor: "buyer:test",
      reason: "RELEASED",
    });
    const third = await startTestCheckout(art.slug, { buyer, ipHash });
    expect(third.result).toEqual({
      kind: "refused",
      code: "artwork_hold_budget",
    });
  });

  it("refuses a re-hold past the 2 h span and past hold_count 3", async () => {
    const art = await buyableArtwork(db);
    const held = await heldOrder(art.slug);
    await execSql(
      "UPDATE artworks SET reserved_until = now() - interval '1 minute' WHERE id = $1",
      [art.id],
    );
    await execSql(
      "UPDATE orders SET first_held_at = now() - interval '3 hours' WHERE id = $1",
      [held.orderId],
    );
    const span = await startPaymentForOrder({
      orderId: held.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: held.input.ipHash,
    });
    expect(span.result).toEqual({
      kind: "refused",
      code: "hold_span_exceeded",
    });

    await execSql(
      "UPDATE orders SET first_held_at = now(), hold_count = 3 WHERE id = $1",
      [held.orderId],
    );
    const count = await startPaymentForOrder({
      orderId: held.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: held.input.ipHash,
    });
    expect(count.result).toEqual({
      kind: "refused",
      code: "hold_count_exceeded",
    });

    await execSql("UPDATE orders SET hold_count = 1 WHERE id = $1", [
      held.orderId,
    ]);
    const again = await startPaymentForOrder({
      orderId: held.orderId,
      providerId: "mock",
      locale: "he",
      ipHash: held.input.ipHash,
    });
    expect(again.result.kind).toBe("redirect");
    const o = await orderRow(held.orderId);
    expect(o.holdCount).toBe(2);
    expect((await artworkRow(art.id)).reservedByOrderId).toBe(held.orderId);
  });

  it("a double submit resumes the same order (sequential and concurrent)", async () => {
    const art = await buyableArtwork(db);
    const input = await checkoutInput(art.slug);
    const results = await race(2, (c) => startCheckout(input, { db: c.db }));
    const { fulfilled, rejected } = partition(results);
    expect(rejected).toEqual([]);
    const ids = fulfilled.map((r) =>
      r.result.kind === "redirect" ? r.result.orderId : r.result.kind,
    );
    expect(ids[0]).toBe(ids[1]);
    const { result: third } = await startCheckout(input);
    expect(third.kind === "redirect" && third.orderId).toBe(ids[0]);
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it("refuses a changed price without writing anything", async () => {
    const art = await buyableArtwork(db);
    const input = await checkoutInput(art.slug);
    await db
      .update(artworks)
      .set({ priceIlsMinor: 160_000 })
      .where(eq(artworks.id, art.id));
    const { result } = await startCheckout(input);
    expect(result.kind).toBe("price_changed");
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it("a live foreign hold is reported as just reserved", async () => {
    const art = await buyableArtwork(db);
    const late = await checkoutInput(art.slug);
    await heldOrder(art.slug);
    const { result } = await startCheckout(late);
    expect(result.kind).toBe("just_reserved");
  });

  it("settings caps are read inside the transaction", async () => {
    await patchSetting("checkout", { maxActiveHoldsPerEmail: 1 });
    const [w1, w2] = await Promise.all([
      buyableArtwork(db),
      buyableArtwork(db),
    ]);
    const buyer = uniqueBuyer();
    await heldOrder(w1.slug, { buyer });
    const { result } = await startTestCheckout(w2.slug, { buyer });
    expect(result).toEqual({ kind: "refused", code: "too_many_holds" });
  });
});
