import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/server/db/client";
import {
  artworks,
  orderItems,
  orders,
  paymentAttempts,
} from "@/server/db/schema";
import { ConflictError } from "@/server/domain/errors";
import { IN_FLIGHT_ATTEMPT_STATUSES } from "@/server/domain/state-machines";
import type { CheckoutSettings } from "@/server/settings/schemas";

/**
 * Reservation rules (spec §3.5; frozen contract). `lockArtworks` is the first step of every
 * transaction that touches artworks (global lock order; lock before any FK insert). The predicates
 * are evaluated on the locked rows; the conditional UPDATEs repeat them in SQL
 * (`reservableSql` / `sellableSql`) and their row counts are checked.
 *
 * Lock order (spec §2.2): artworks (ORDER BY id) → per-buyer advisory xact locks → orders
 * (ORDER BY id) → payment_attempts → refunds.
 */
export type LockedArtwork = typeof artworks.$inferSelect;

/** `SELECT … FROM artworks WHERE id = ANY($ids) ORDER BY id FOR UPDATE`. */
export async function lockArtworks(
  tx: Tx,
  ids: readonly string[],
): Promise<LockedArtwork[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)].sort();
  return tx
    .select()
    .from(artworks)
    .where(inArray(artworks.id, unique))
    .orderBy(asc(artworks.id))
    .for("update");
}

export interface HoldContext {
  /** The order trying to hold or pay. */
  orderId: string | null;
  now: Date;
  /**
   * Whether the order currently holding the work has an attempt in CAPTURING or PAYMENT_REVIEW
   * (the "in-flight foreign hold" predicate). Query it with the rows locked.
   */
  foreignHoldInFlight: boolean;
}

function holdAvailable(a: LockedArtwork, c: HoldContext): boolean {
  if (a.reservedByOrderId === null) return true;
  if (c.orderId !== null && a.reservedByOrderId === c.orderId) return true;
  return (
    a.reservedUntil !== null &&
    a.reservedUntil.getTime() <= c.now.getTime() &&
    !c.foreignHoldInFlight
  );
}

/**
 * Reservable for order `$o`: published, AVAILABLE, and free / ours / an expired foreign hold that
 * is not in flight. WEB checkout additionally requires `NOT quote_only AND NOT price_on_request`
 * (link orders created by the admin may bypass both).
 */
export function isReservable(
  a: LockedArtwork,
  c: HoldContext & { web: boolean },
): boolean {
  if (!a.isPublished || a.saleStatus !== "AVAILABLE") return false;
  if (c.web && (a.quoteOnly || a.priceOnRequest)) return false;
  return holdAvailable(a, c);
}

/**
 * Sellable at finalization for `$o`: AVAILABLE and free / ours / an expired foreign hold that is not
 * in flight. `is_published` is not required (a late payment for a free unpublished work is kept).
 */
export function isSellable(a: LockedArtwork, c: HoldContext): boolean {
  return a.saleStatus === "AVAILABLE" && holdAvailable(a, c);
}

// ---------------------------------------------------------------- SQL forms of the predicates

/** The in-flight foreign hold predicate on `artworks` (an attempt of the holding order in flight). */
const inFlightHold = sql`EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = ${artworks.reservedByOrderId} AND pa.status IN ('CAPTURING', 'PAYMENT_REVIEW'))`;

/** Free, ours, or an expired foreign hold that is not in flight. */
function holdAvailableSql(orderId: string) {
  return sql`(${artworks.reservedByOrderId} IS NULL OR ${artworks.reservedByOrderId} = ${orderId} OR (${artworks.reservedUntil} <= now() AND NOT ${inFlightHold}))`;
}

/** SQL form of `isReservable` (repeated in the conditional reserve UPDATE). */
export function reservableSql(orderId: string, web: boolean) {
  return and(
    eq(artworks.isPublished, true),
    eq(artworks.saleStatus, "AVAILABLE"),
    web
      ? sql`NOT ${artworks.quoteOnly} AND NOT ${artworks.priceOnRequest}`
      : undefined,
    holdAvailableSql(orderId),
  );
}

/** SQL form of `isSellable` (repeated in the SOLD UPDATE). */
export function sellableSql(orderId: string) {
  return and(eq(artworks.saleStatus, "AVAILABLE"), holdAvailableSql(orderId));
}

// ---------------------------------------------------------------- helpers used under the locks

/** Orders (among `orderIds`) that have an attempt in CAPTURING or PAYMENT_REVIEW. */
export async function ordersWithAttemptInFlight(
  tx: DbOrTx,
  orderIds: readonly (string | null)[],
): Promise<Set<string>> {
  const ids = [...new Set(orderIds.filter((x): x is string => x !== null))];
  if (ids.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.orderId, ids),
        inArray(paymentAttempts.status, [...IN_FLIGHT_ATTEMPT_STATUSES]),
      ),
    );
  return new Set(rows.map((r) => r.orderId));
}

/** `HoldContext` per locked artwork (the in-flight flag concerns the *foreign* holder only). */
export async function holdContexts(
  tx: Tx,
  locked: readonly LockedArtwork[],
  orderId: string | null,
  now: Date,
): Promise<Map<string, HoldContext>> {
  const inFlight = await ordersWithAttemptInFlight(
    tx,
    locked
      .map((a) => a.reservedByOrderId)
      .filter((id) => id !== null && id !== orderId),
  );
  const out = new Map<string, HoldContext>();
  for (const a of locked) {
    out.set(a.id, {
      orderId,
      now,
      foreignHoldInFlight:
        a.reservedByOrderId !== null && inFlight.has(a.reservedByOrderId),
    });
  }
  return out;
}

/** Every locked artwork is reservable for `orderId`. */
export async function allReservable(
  tx: Tx,
  locked: readonly LockedArtwork[],
  orderId: string | null,
  web: boolean,
  now: Date,
): Promise<boolean> {
  const ctx = await holdContexts(tx, locked, orderId, now);
  return locked.every((a) =>
    isReservable(a, { ...(ctx.get(a.id) as HoldContext), web }),
  );
}

/** Every locked artwork is sellable for `orderId`. */
export async function allSellable(
  tx: Tx,
  locked: readonly LockedArtwork[],
  orderId: string,
  now: Date,
): Promise<boolean> {
  const ctx = await holdContexts(tx, locked, orderId, now);
  return locked.every((a) => isSellable(a, ctx.get(a.id) as HoldContext));
}

/** The artworks of an order (items are immutable after insert, so read without locks). */
export async function orderArtworkIds(
  tx: DbOrTx,
  orderId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ artworkId: orderItems.artworkId })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return rows.map((r) => r.artworkId);
}

/** `SELECT … FROM orders WHERE id = $id FOR UPDATE` (after the artworks, spec §2.2). */
export async function lockOrder(tx: Tx, orderId: string) {
  const [row] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update");
  return row ?? null;
}

/** `SELECT … FROM payment_attempts WHERE id = $id FOR UPDATE` (after the order). */
export async function lockAttempt(tx: Tx, attemptId: string) {
  const [row] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId))
    .for("update");
  return row ?? null;
}

/**
 * Per-buyer advisory transaction locks (spec §3.5 step 2), in sorted order so two transactions
 * for the same buyer never deadlock. Released at commit (safe with pooling).
 */
export async function takeBuyerLocks(
  tx: Tx,
  buyer: { email: string; ipHash: string | null },
): Promise<void> {
  const keys = [`hold:e:${buyer.email.trim().toLowerCase()}`];
  if (buyer.ipHash) keys.push(`hold:i:${buyer.ipHash}`);
  keys.sort();
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

export type HoldRefusal =
  | "too_many_holds"
  | "artwork_hold_budget"
  | "hold_cooldown"
  | "hold_count_exceeded"
  | "hold_span_exceeded";

/** A business rule refused the hold (spec §3.5 "Anti-hoarding"); the caller rolls back. */
export class HoldRefusedError extends ConflictError {
  constructor(public readonly refusal: HoldRefusal) {
    super("HOLD_REFUSED", `hold refused: ${refusal}`, { refusal });
    this.name = "HoldRefusedError";
  }
}

/**
 * Anti-hoarding caps (spec §3.5), counted **inside** the transaction after `takeBuyerLocks`, so
 * two concurrent checkouts of one buyer cannot both pass. `excludeOrderId` is the order being
 * (re-)held, which never counts against itself. Only WEB orders count (link orders are the
 * painter's own decision).
 */
export async function checkHoldCaps(
  tx: Tx,
  i: {
    email: string;
    ipHash: string | null;
    artworkIds: readonly string[];
    excludeOrderId: string | null;
    settings: CheckoutSettings;
  },
): Promise<void> {
  const email = i.email.trim().toLowerCase();
  const exclude = i.excludeOrderId ?? "00000000-0000-0000-0000-000000000000";
  const ip = i.ipHash;
  const s = i.settings;
  const sameBuyer = ip
    ? sql`(lower(o.buyer_email) = ${email} OR o.client_ip_hash = ${ip})`
    : sql`lower(o.buyer_email) = ${email}`;
  const byIp = ip ? sql`o.client_ip_hash = ${ip}` : sql`false`;

  // Live WEB holds per email and per IP hash.
  const live = await tx.execute<{ by_email: string; by_ip: string }>(sql`
    SELECT
      count(DISTINCT o.id) FILTER (WHERE lower(o.buyer_email) = ${email}) AS by_email,
      count(DISTINCT o.id) FILTER (WHERE ${byIp}) AS by_ip
    FROM artworks a JOIN orders o ON o.id = a.reserved_by_order_id
    WHERE a.reserved_until > now() AND o.source = 'WEB' AND o.id <> ${exclude}::uuid
      AND ${sameBuyer}`);
  const liveRow = live.rows[0];
  if (Number(liveRow?.by_email ?? 0) >= s.maxActiveHoldsPerEmail) {
    throw new HoldRefusedError("too_many_holds");
  }
  if (ip && Number(liveRow?.by_ip ?? 0) >= s.maxActiveHoldsPerIp) {
    throw new HoldRefusedError("too_many_holds");
  }

  if (i.artworkIds.length === 0) return;
  const ids = sql.join(
    i.artworkIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Per artwork: at most N holding orders per email and per IP hash in 24 h, and a cooldown after
  // the buyer's own hold on that work lapsed.
  const per = await tx.execute<{
    by_email: string;
    by_ip: string;
    cooling: string;
  }>(sql`
    SELECT
      count(DISTINCT o.id) FILTER (WHERE lower(o.buyer_email) = ${email} AND o.first_held_at > now() - interval '24 hours') AS by_email,
      count(DISTINCT o.id) FILTER (WHERE ${byIp} AND o.first_held_at > now() - interval '24 hours') AS by_ip,
      count(DISTINCT o.id) FILTER (WHERE o.status IN ('AWAITING_PAYMENT', 'EXPIRED')
        AND (o.status_reason IS NULL OR o.status_reason IN ('HOLD_EXPIRED', 'HOLD_TAKEN_OVER'))
        AND o.expires_at <= now()
        AND o.expires_at > now() - make_interval(mins => ${s.holdCooldownMinutes}::int)) AS cooling
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE oi.artwork_id IN (${ids}) AND o.id <> ${exclude}::uuid AND o.source = 'WEB'
      AND ${sameBuyer}`);
  const perRow = per.rows[0];
  if (
    Number(perRow?.by_email ?? 0) >= s.maxHoldsPerArtworkPerBuyer24h ||
    Number(perRow?.by_ip ?? 0) >= s.maxHoldsPerArtworkPerBuyer24h
  ) {
    throw new HoldRefusedError("artwork_hold_budget");
  }
  if (Number(perRow?.cooling ?? 0) > 0) {
    throw new HoldRefusedError("hold_cooldown");
  }
}

/**
 * The conditional reserve UPDATE (spec §3.5 step 5): the reservable predicate is repeated in
 * `WHERE`, and the row count must equal n. Returns false when another order got there first (the
 * caller then rolls back).
 */
export async function reserveArtworks(
  tx: Tx,
  i: {
    artworkIds: readonly string[];
    orderId: string;
    until: Date;
    web: boolean;
  },
): Promise<boolean> {
  const ids = [...new Set(i.artworkIds)];
  const rows = await tx
    .update(artworks)
    .set({ reservedByOrderId: i.orderId, reservedUntil: i.until })
    .where(and(inArray(artworks.id, ids), reservableSql(i.orderId, i.web)))
    .returning({ id: artworks.id });
  return rows.length === ids.length;
}

/**
 * Takeover expiry (spec §3.5 step 6): orders whose expired holds were just taken over become
 * EXPIRED (`HOLD_TAKEN_OVER`), AWAITING_PAYMENT only. Their order rows are updated here, after the
 * artworks (lock order), in id order.
 */
export async function expireTakenOverOrders(
  tx: Tx,
  previousHolders: readonly (string | null)[],
  takenBy: string,
): Promise<string[]> {
  const ids = [
    ...new Set(
      previousHolders.filter(
        (id): id is string => id !== null && id !== takenBy,
      ),
    ),
  ].sort();
  const expired: string[] = [];
  for (const id of ids) {
    const rows = await tx
      .update(orders)
      .set({
        status: "EXPIRED",
        statusReason: "HOLD_TAKEN_OVER",
        expiresAt: sql`least(coalesce(${orders.expiresAt}, now()), now())`,
      })
      .where(and(eq(orders.id, id), eq(orders.status, "AWAITING_PAYMENT")))
      .returning({ id: orders.id });
    if (rows[0]) expired.push(rows[0].id);
  }
  return expired;
}

/** Clears every hold of `orderId` (the caller has locked those artworks first). */
export async function releaseHoldsOf(tx: Tx, orderId: string): Promise<number> {
  const rows = await tx
    .update(artworks)
    .set({ reservedByOrderId: null, reservedUntil: null })
    .where(eq(artworks.reservedByOrderId, orderId))
    .returning({ id: artworks.id });
  return rows.length;
}
