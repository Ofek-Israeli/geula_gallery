/**
 * Compliance test factories (WS6, spec §9.3: streams add `factories/<stream>.ts`).
 *
 * - `testAdmin()`: an `AdminContext` for services that require one (integration tests only).
 * - `validIsraeliId()`: a random 9-digit ID with a correct check digit (never a real person's;
 *   generated per run, never committed).
 * - `paidTestOrder()`: a real WEB purchase driven through checkout → mock pay → finalize.
 * - `notice()`: a cancellation notice as the public form would submit it.
 *
 * App modules are imported lazily so Playwright specs can import `validIsraeliId` safely.
 */
import { randomInt } from "node:crypto";
import { israeliIdCheckDigit } from "@/lib/il-id";
import type { CheckoutOptions } from "./commerce";

type AdminContext = import("@/server/domain/admin").AdminContext;
type Notice = import("@/server/cancellations/notice").CancellationNotice;
type DbOrTx = import("@/server/db/client").DbOrTx;

export function testAdmin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "u-test",
    email: "e2e-admin@example.test",
    name: "Painter",
    sessionId: "s-test",
    sessionCreatedAt: new Date(),
    twoFactorEnabled: true,
    locale: "he",
    ipHash: null,
    actor: "admin:u-test",
    ...overrides,
  } as unknown as AdminContext;
}

/** A random, checksum-valid Israeli ID number (9 digits, never starting with 0). */
export function validIsraeliId(): string {
  const eight = `${randomInt(1, 10)}${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
  return `${eight}${israeliIdCheckDigit(eight)}`;
}

/** A paid WEB order (IL local pickup by default) and its attempt. */
export async function paidTestOrder(
  opts: CheckoutOptions & { artwork?: Record<string, unknown> } = {},
) {
  const [{ db }, schema, { eq }, commerce, { finalizeAttempt }] =
    await Promise.all([
      import("@/server/db/client"),
      import("@/server/db/schema"),
      import("drizzle-orm"),
      import("./commerce"),
      import("@/server/payments/finalize"),
    ]);
  const art = await commerce.buyableArtwork(db, opts.artwork ?? {});
  const h = await commerce.heldOrder(art.slug, opts);
  await commerce.clickMockPay(h.ref, "pay");
  const { result } = await finalizeAttempt(h.attemptId, { trigger: "return" });
  if (result.outcome !== "paid") {
    throw new Error(`paidTestOrder: finalize → ${result.outcome}`);
  }
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, h.orderId));
  if (!order) throw new Error("paidTestOrder: order");
  return { order, artwork: art, attemptId: h.attemptId, input: h.input };
}

/** A notice as the public form submits it (validated shape). */
export function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    fullName: "Test Buyer",
    eligibleGroup: "NONE",
    ...overrides,
  } as Notice;
}

/** Marks an order delivered (and its shipment) at `at` — arranging state only. */
export async function markDelivered(
  db: DbOrTx,
  orderId: string,
  at: Date,
  status: "DELIVERED" | "COLLECTED" = "DELIVERED",
) {
  const [schema, { eq }] = await Promise.all([
    import("@/server/db/schema"),
    import("drizzle-orm"),
  ]);
  await db
    .update(schema.orders)
    .set({ deliveredAt: at })
    .where(eq(schema.orders.id, orderId));
  await db
    .update(schema.shipments)
    .set({ status, deliveredAt: at })
    .where(eq(schema.shipments.orderId, orderId));
}
