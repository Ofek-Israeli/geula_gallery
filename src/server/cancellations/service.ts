import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  cancellationBase,
  cancellationRefund,
} from "@/lib/cancellation-amounts";
import { isEuCountry } from "@/lib/countries";
import { refundDueAt as legalRefundDueAt } from "@/lib/deadlines";
import { formatDateTime } from "@/lib/format";
import { identityLast3 } from "@/lib/il-id";
import type { Locale } from "@/lib/locale";
import { raiseAlert } from "@/server/alerts/service";
import { audit } from "@/server/audit";
import { detectConversation } from "@/server/checkout/conversation";
import { lockArtworks } from "@/server/checkout/reservations";
import {
  type Db,
  type DbOrTx,
  db as defaultDb,
  type Tx,
} from "@/server/db/client";
import {
  type Cancellation,
  cancellationItems,
  cancellations,
  type Order,
  orders,
  paymentAttempts,
  refunds,
  sales,
  shipments,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { newCancellationNumber } from "@/server/domain/ids";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { log } from "@/server/log";
import {
  activeOrderItems,
  itemsOfCancellation,
  type OrderItemState,
  orderItemsWithState,
} from "@/server/orders/items";
import { enqueueEmail } from "@/server/outbox/enqueue";
import { countedRefundsMinor, requestRefund } from "@/server/payments/refunds";
import { encryptAesGcm } from "@/server/security/crypto";
import { piiKey } from "@/server/security/keys";
import { getSetting } from "@/server/settings";
import { carrierAdapter } from "@/server/shipping/registry";
import {
  cancelShipmentForOrder,
  removeItemsFromShipment,
} from "@/server/shipping/shipments";
import { assessCancellation, clampFee } from "./fees";
import {
  type CancellationNotice,
  displayNotice,
  type NoticeDisplay,
} from "./notice";
import { cancelOrderIfFullyCancelled } from "./settlement";

/**
 * Cancellation notices (spec §5.7): intake that never blocks, matching, duplicates, deadlines and
 * the admin decision (accept → refund or return; reject; duplicate; return; inspection; close;
 * relist / mark damaged).
 *
 * Rules:
 * - `recordCancellationNotice` **always inserts** a RECEIVED row (`received_at`, `refund_due_at` =
 *   +14 days) and enqueues the acknowledgement (`cancellation-ack`, when an email was given) and
 *   `painter-cancellation` in the same transaction. Matching runs afterwards in its own
 *   transaction; a matching failure is logged and never undoes the notice.
 * - There is no unique index on `order_id`: a second notice for the same order is stored, flagged
 *   `possible_duplicate` with `duplicate_of_id`, and acknowledged like the first.
 * - Matching sets `orders.fulfillment_blocked_reason = 'PENDING_CANCELLATION'` (on a PAID order
 *   with no other block) and re-runs conversation detection on the order.
 * - Per work: a notice names the works to cancel (`requested_item_ids`; null = every work still
 *   active). Acceptance writes `cancellation_items` (a work is cancelled once), refunds the works'
 *   prices (plus shipping only when no work is left), and either repacks the remaining works or
 *   cancels the shipment. The order becomes CANCELLED only when every work is cancelled and
 *   settled (`settlement.ts`). Duplicates are flagged only when the works overlap.
 * - Lock order: artworks → order → payment attempt → refunds → cancellation (spec §2.2).
 * - The full ID number exists only encrypted (`id_number_enc`, AES-256-GCM bound to the row id);
 *   `id_number_last3` helps the admin match; every other place shows `•••••••12`.
 */
export interface CancellationDeps {
  db?: Db;
  now?: Date;
}

export type CancellationRow = Cancellation;

/** Statuses of a notice that still needs the painter's action ("open"). */
export const OPEN_CANCELLATION_STATUSES = ["RECEIVED", "ACCEPTED"] as const;

/** A label call whose outcome is unknown: resolve it on the fulfillment screen first. */
const LABEL_PENDING: readonly ShipmentStatus[] = [
  "LABEL_REQUESTED",
  "LABEL_UNKNOWN",
];

/** The acknowledgement content stored in `ack_snapshot` and shown on screen (ID masked). */
export interface AckSnapshot extends NoticeDisplay {
  number: string;
  channel: Cancellation["channel"];
  receivedAt: string;
  refundDueAt: string;
  locale: Locale;
  /** Human-readable time in Asia/Jerusalem, as shown to the buyer. */
  receivedAtText: string;
  /** Titles of the works the buyer chose (absent = the whole order). */
  works?: string[];
}

export interface NoticeMeta {
  locale: Locale;
  channel?: Cancellation["channel"];
  /** Admin-logged notices carry the actual receipt time (spec §5.7 step 5). */
  receivedAt?: Date;
  actor: string;
  ipHash?: string | null;
  /** Admin-logged notices may name the order directly. */
  orderId?: string;
  /**
   * The works the buyer chose (order item ids and titles, from `previewCancellableItems`); absent
   * or every work = the whole order.
   */
  requestedItems?: readonly { id: string; title: string }[];
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Auto-match rule: order number plus (email or name) (spec §5.7 step 5). */
export function identityMatches(
  notice: { email: string | null; fullName: string },
  order: { buyerEmail: string | null; buyerName: string | null },
): boolean {
  const emailOk =
    !!notice.email &&
    !!order.buyerEmail &&
    notice.email.trim().toLowerCase() === order.buyerEmail.trim().toLowerCase();
  const name = normalizeName(notice.fullName);
  const nameOk = name !== "" && name === normalizeName(order.buyerName);
  return emailOk || nameOk;
}

function regimeFor(country: string | null | undefined): "IL" | "EU" {
  return country && isEuCountry(country) ? "EU" : "IL";
}

// ---------------------------------------------------------------- intake

/**
 * Stores a cancellation notice (web form or admin-logged). Never refuses a valid notice: duplicates
 * are stored and flagged. Returns the acknowledgement shown on screen.
 */
export async function recordCancellationNotice(
  notice: CancellationNotice,
  meta: NoticeMeta,
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ id: string; ack: AckSnapshot }>> {
  const db = deps.db ?? defaultDb;
  const receivedAt = meta.receivedAt ?? deps.now ?? new Date();
  const channel = meta.channel ?? "WEB";
  const profile = await getSetting("business_profile", db);

  const { id, ack } = await withTx(
    async (tx) => {
      const id = randomUUID();
      // Lock before the FK insert that references the order (spec §2.2).
      if (meta.orderId) await lockOrder(tx, meta.orderId);
      const due = legalRefundDueAt(receivedAt);
      const display = displayNotice(notice);
      const requested = meta.requestedItems?.length
        ? meta.requestedItems
        : null;
      let number = "";
      let inserted = false;
      for (let i = 0; i < 6 && !inserted; i++) {
        number = newCancellationNumber();
        const ack: AckSnapshot = {
          ...display,
          number,
          channel,
          receivedAt: receivedAt.toISOString(),
          refundDueAt: due.toISOString(),
          locale: meta.locale,
          receivedAtText: formatDateTime(receivedAt, meta.locale),
          ...(requested ? { works: requested.map((i) => i.title) } : {}),
        };
        const rows = await tx
          .insert(cancellations)
          .values({
            id,
            number,
            orderId: meta.orderId ?? null,
            regime: notice.shippedTo === "EU" ? "EU" : "IL",
            status: "RECEIVED",
            returnStatus: "NOT_APPLICABLE",
            channel,
            reason: notice.reason ?? null,
            fullName: notice.fullName,
            idNumberEnc: notice.idNumber
              ? encryptAesGcm(
                  piiKey(),
                  notice.idNumber.value,
                  `cancellations.id_number:${id}`,
                )
              : null,
            idNumberLast3: notice.idNumber
              ? identityLast3(notice.idNumber.value)
              : null,
            orderNumberInput: notice.orderNumber ?? null,
            email: notice.email ?? null,
            phone: notice.phone ?? null,
            message: notice.message ?? null,
            eligibleGroup: notice.eligibleGroup,
            requestedItemIds: requested ? requested.map((i) => i.id) : null,
            receivedAt,
            refundDueAt: due,
            ackSnapshot: ack,
          })
          .onConflictDoNothing({ target: cancellations.number })
          .returning({ id: cancellations.id });
        inserted = rows.length > 0;
      }
      if (!inserted)
        throw new Error("could not allocate a cancellation number");

      if (notice.email) {
        await enqueueEmail(tx, {
          template: "cancellation-ack",
          to: notice.email,
          locale: meta.locale,
          refId: id,
        });
      }
      await enqueueEmail(tx, {
        template: "painter-cancellation",
        to: profile.notificationEmail,
        locale: "he",
        refId: id,
      });
      await audit(
        {
          actor: meta.actor,
          action: "cancellation.received",
          entity: "cancellation",
          entityId: id,
          after: { number, channel, receivedAt: receivedAt.toISOString() },
          ipHash: meta.ipHash ?? null,
        },
        tx,
      );
      const [row] = await tx
        .select({ ack: cancellations.ackSnapshot })
        .from(cancellations)
        .where(eq(cancellations.id, id));
      return { id, ack: row?.ack as AckSnapshot };
    },
    { db, name: "cancellation.receive" },
  );

  // Matching never blocks (or undoes) the notice.
  try {
    if (meta.orderId) {
      await withTx(
        async (tx) => {
          const order = await lockOrder(tx, meta.orderId as string);
          await linkToOrder(tx, id, order, meta.actor, deps.now);
        },
        { db, name: "cancellation.link" },
      );
    } else {
      await autoMatchCancellation(id, { db, now: deps.now });
    }
  } catch (error) {
    log.warn("cancellation.match_failed", { cancellationId: id }, error);
  }

  return withEffects({ id, ack }, { outbox: true, revalidate: true });
}

async function lockOrder(tx: Tx, orderId: string): Promise<Order> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update");
  if (!order) throw new NotFoundError("order", orderId);
  return order;
}

async function lockCancellation(tx: Tx, id: string): Promise<Cancellation> {
  const [row] = await tx
    .select()
    .from(cancellations)
    .where(eq(cancellations.id, id))
    .for("update");
  if (!row) throw new NotFoundError("cancellation", id);
  return row;
}

/**
 * Auto-match on order number plus (email or name). Returns whether the notice is now linked.
 * Idempotent: an already linked notice is left alone.
 */
export async function autoMatchCancellation(
  cancellationId: string,
  deps: CancellationDeps = {},
): Promise<{ matched: boolean; orderId: string | null }> {
  const db = deps.db ?? defaultDb;
  return withTx(
    async (tx) => {
      const [c] = await tx
        .select()
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!c) throw new NotFoundError("cancellation", cancellationId);
      if (c.orderId) return { matched: true, orderId: c.orderId };
      if (!c.orderNumberInput) return { matched: false, orderId: null };
      const [candidate] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.number, c.orderNumberInput));
      if (!candidate) return { matched: false, orderId: null };
      const order = await lockOrder(tx, candidate.id);
      if (!identityMatches(c, order)) return { matched: false, orderId: null };
      await linkToOrder(tx, c.id, order, "system", deps.now);
      return { matched: true, orderId: order.id };
    },
    { db, name: "cancellation.match" },
  );
}

/**
 * Links a notice to an order (the order row must already be locked by the caller): duplicate
 * flags (only when the works overlap an earlier open notice), the requested works narrowed to the
 * order's, regime, conversation re-detection, the deadline assessment and the fulfillment block.
 */
async function linkToOrder(
  tx: Tx,
  cancellationId: string,
  order: Order,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const c = await lockCancellation(tx, cancellationId);
  if (c.orderId && c.orderId !== order.id) {
    throw new ConflictError(
      "ALREADY_MATCHED",
      "the notice is linked to another order",
    );
  }
  const items = await orderItemsWithState(tx, order.id);
  const requestedItemIds = narrowRequested(c.requestedItemIds, items);
  const mine = noticeItemSet(requestedItemIds, items);
  const others = await tx
    .select({
      id: cancellations.id,
      status: cancellations.status,
      requestedItemIds: cancellations.requestedItemIds,
    })
    .from(cancellations)
    .where(
      and(
        eq(cancellations.orderId, order.id),
        ne(cancellations.id, c.id),
        inArray(cancellations.status, [...OPEN_CANCELLATION_STATUSES]),
      ),
    )
    .orderBy(asc(cancellations.receivedAt));
  // A second notice is a possible duplicate only when it names a work an earlier one names.
  const first = others.find((o) => {
    const theirs =
      o.status === "ACCEPTED"
        ? new Set(
            items.filter((i) => i.cancellation?.id === o.id).map((i) => i.id),
          )
        : noticeItemSet(o.requestedItemIds, items);
    return [...mine].some((id) => theirs.has(id));
  });

  // Conversation detection again (spec §5.7 step 5): it can only lengthen the window.
  let conversationTookPlace = order.conversationTookPlace;
  if (!conversationTookPlace && order.buyerEmail) {
    const checkout = await getSetting("checkout", tx);
    const found = await detectConversation(tx, {
      email: order.buyerEmail,
      lookbackDays: checkout.conversationLookbackDays,
      now: order.createdAt,
    });
    if (found.tookPlace) {
      conversationTookPlace = true;
      await tx
        .update(orders)
        .set({
          conversationTookPlace: true,
          conversationSource: found.source,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
    }
  }

  const assessment = await assessFor(
    tx,
    c,
    { ...order, conversationTookPlace },
    { orderItemIds: requestedItemIds },
  );
  await tx
    .update(cancellations)
    .set({
      orderId: order.id,
      regime: regimeFor(order.shipCountry),
      requestedItemIds,
      ...(first ? { possibleDuplicate: true, duplicateOfId: first.id } : {}),
      windowEndsAt: assessment?.window.end ?? null,
      withinWindow: assessment?.withinWindow ?? null,
      feeMinor: assessment?.suggestedFeeMinor ?? null,
      refundAmountMinor: assessment?.refundAmountMinor ?? null,
      updatedAt: now,
    })
    .where(eq(cancellations.id, c.id));

  if (
    c.status === "RECEIVED" &&
    order.status === "PAID" &&
    order.fulfillmentBlockedReason === null
  ) {
    await tx
      .update(orders)
      .set({ fulfillmentBlockedReason: "PENDING_CANCELLATION", updatedAt: now })
      .where(eq(orders.id, order.id));
  }
  await audit(
    {
      actor,
      action: "cancellation.matched",
      entity: "cancellation",
      entityId: c.id,
      after: {
        orderId: order.id,
        possibleDuplicate: Boolean(first),
        duplicateOfId: first?.id ?? null,
      },
    },
    tx,
  );
}

/**
 * The requested works narrowed to the order's own items (unknown ids dropped); null when nothing
 * is left or every item is named (= the whole order).
 */
function narrowRequested(
  requested: readonly string[] | null,
  items: readonly OrderItemState[],
): string[] | null {
  if (!requested) return null;
  const known = new Set(items.map((i) => i.id));
  const ids = [...new Set(requested)].filter((id) => known.has(id));
  if (ids.length === 0 || ids.length === items.length) return null;
  return ids;
}

/** The works a (not yet accepted) notice is about: the requested ones, else every active work. */
function noticeItemSet(
  requested: readonly string[] | null,
  items: readonly OrderItemState[],
): Set<string> {
  if (requested) return new Set(requested);
  return new Set(items.filter((i) => i.cancellation === null).map((i) => i.id));
}

export interface AssessedItem {
  id: string;
  artworkId: string;
  titleHe: string;
  titleEn: string;
  priceMinor: number;
}

/**
 * The assessment for a notice, its order and the works to cancel (`orderItemIds`; null = every
 * work still active). Works already cancelled are skipped. Null when the order was never paid.
 */
async function assessFor(
  tx: DbOrTx,
  c: Pick<
    Cancellation,
    "id" | "regime" | "reason" | "eligibleGroup" | "receivedAt"
  >,
  order: Order,
  opts: {
    grantFourMonths?: boolean;
    orderItemIds?: readonly string[] | null;
  } = {},
) {
  if (!order.paidAttemptId) return null;
  const [attempt] = await tx
    .select({ amountMinor: paymentAttempts.amountMinor })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, order.paidAttemptId));
  if (!attempt) return null;
  const rows = await tx
    .select({
      amountMinor: refunds.amountMinor,
      status: refunds.status,
      failureConfirmedAt: refunds.failureConfirmedAt,
    })
    .from(refunds)
    .where(eq(refunds.attemptId, order.paidAttemptId));
  const policy = await getSetting("cancellation_policy", tx);
  const all = await orderItemsWithState(tx, order.id);
  const active = all.filter((i) => i.cancellation === null);
  const wanted = opts.orderItemIds ? new Set(opts.orderItemIds) : null;
  const selected = active.filter((i) => !wanted || wanted.has(i.id));
  const base = cancellationBase({
    cancelledItemsMinor: selected.reduce((s, i) => s + i.priceMinor, 0),
    orderItemsMinor: all.reduce((s, i) => s + i.priceMinor, 0),
    paidMinor: attempt.amountMinor,
    final: selected.length > 0 && selected.length === active.length,
  });
  // The ₪100 cap is shared by every fee withheld on the order: accepted notices only (they cover
  // works). A notice closed as a duplicate or rejected keeps its suggestion, never withheld.
  const [withheld] = await tx
    .select({
      sum: sql<number>`coalesce(sum(${cancellations.feeMinor}), 0)::int`,
    })
    .from(cancellations)
    .where(
      and(
        eq(cancellations.orderId, order.id),
        ne(cancellations.id, c.id),
        inArray(cancellations.status, ["ACCEPTED", "CLOSED"]),
        sql`EXISTS (SELECT 1 FROM cancellation_items ci WHERE ci.cancellation_id = ${cancellations.id})`,
      ),
    );
  const alreadyRefundedMinor = countedRefundsMinor(rows);
  const feesWithheldMinor = withheld?.sum ?? 0;
  const assessment = assessCancellation({
    order,
    paidMinor: attempt.amountMinor,
    alreadyRefundedMinor,
    baseMinor: base.baseMinor,
    feesWithheldMinor,
    regime: regimeFor(order.shipCountry) ?? c.regime,
    reason: c.reason,
    eligibleGroup: c.eligibleGroup,
    receivedAt: c.receivedAt,
    policy: policy.changeOfMindFee,
    ...(opts.grantFourMonths !== undefined
      ? { grantFourMonths: opts.grantFourMonths }
      : {}),
  });
  return {
    ...assessment,
    ...base,
    paidMinor: attempt.amountMinor,
    alreadyRefundedMinor,
    feesWithheldMinor,
    final: selected.length > 0 && selected.length === active.length,
    items: selected.map(
      (i): AssessedItem => ({
        id: i.id,
        artworkId: i.artworkId,
        titleHe: i.titleHe,
        titleEn: i.titleEn,
        priceMinor: i.priceMinor,
      }),
    ),
  };
}

/** Clears the PENDING_CANCELLATION block when no open notice is left for the order. */
async function releaseBlockIfClear(tx: Tx, orderId: string, now: Date) {
  const [open] = await tx
    .select({ id: cancellations.id })
    .from(cancellations)
    .where(
      and(
        eq(cancellations.orderId, orderId),
        eq(cancellations.status, "RECEIVED"),
      ),
    )
    .limit(1);
  if (open) return;
  await tx
    .update(orders)
    .set({ fulfillmentBlockedReason: null, updatedAt: now })
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.fulfillmentBlockedReason, "PENDING_CANCELLATION"),
      ),
    );
}

// ---------------------------------------------------------------- admin decisions

/** Admin: link an unmatched notice to an order by number (spec §6.10 "duplicate linking", match). */
export async function matchCancellationToOrder(
  ctx: AdminContext,
  cancellationId: string,
  orderNumber: string,
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ orderId: string }>> {
  const db = deps.db ?? defaultDb;
  const orderId = await withTx(
    async (tx) => {
      const [o] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.number, orderNumber));
      if (!o) throw new NotFoundError("order", orderNumber);
      const order = await lockOrder(tx, o.id);
      await linkToOrder(tx, cancellationId, order, ctx.actor, deps.now);
      return order.id;
    },
    { db, name: "cancellation.admin_match" },
  );
  return withEffects({ orderId }, { revalidate: true });
}

export interface AcceptInput {
  /**
   * The works to cancel (order item ids, all still active). Default: the works the buyer named,
   * else every work still active.
   */
  orderItemIds?: readonly string[];
  /** The fee the admin chose; clamped to the suggestion (may only be lowered). */
  feeMinor?: number;
  /** Grant the 4-month window although no conversation is on record. */
  grantFourMonths?: boolean;
  note?: string;
}

/**
 * Accept (spec §5.7 step 7), for the chosen works. Not shipped → the refund is requested now (due
 * date = the notice + 14 days), and the shipment is CANCELLED when no work is left, or repacked
 * for the remaining works (`removeItemsFromShipment`, which also lifts the fulfillment block).
 * Shipped → AWAITING_RETURN and the `return-instructions` email; the refund is requested with
 * `refundCancellation` (whether it may wait for the return is a lawyer question; the admin
 * decides). Works on PAID **and** COMPLETED orders.
 */
export async function acceptCancellation(
  ctx: AdminContext,
  cancellationId: string,
  input: AcceptInput = {},
  deps: CancellationDeps = {},
): Promise<
  ServiceResult<{
    refundId: string | null;
    returnRequired: boolean;
    feeMinor: number;
    refundAmountMinor: number;
    orderItemIds: string[];
    /** No work of the order is left active. */
    final: boolean;
  }>
> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const result = await withTx(
    async (tx) => {
      const [head] = await tx
        .select()
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!head) throw new NotFoundError("cancellation", cancellationId);
      if (!head.orderId) {
        throw new ConflictError(
          "NOT_MATCHED",
          "match the notice to an order first",
        );
      }
      // artworks → order → attempt → refunds → cancellation
      const items = await orderItemsWithState(tx, head.orderId);
      await lockArtworks(
        tx,
        items.map((i) => i.artworkId),
      );
      const order = await lockOrder(tx, head.orderId);
      if (order.status !== "PAID" && order.status !== "COMPLETED") {
        throw new ConflictError("ORDER_NOT_PAID", `order is ${order.status}`);
      }
      if (!order.paidAttemptId) {
        throw new ConflictError("ORDER_NOT_PAID", "order has no payment");
      }
      await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, order.paidAttemptId))
        .for("update");
      const c = await lockCancellation(tx, cancellationId);
      if (c.status !== "RECEIVED") {
        throw new ConflictError("NOT_RECEIVED", `notice is ${c.status}`);
      }
      // The works: the admin's choice, else the buyer's, else every active work.
      const active = new Set(
        (await activeOrderItems(tx, order.id)).map((i) => i.id),
      );
      const chosen = input.orderItemIds
        ? [...new Set(input.orderItemIds)]
        : (c.requestedItemIds ?? null);
      if (input.orderItemIds) {
        const stray = chosen?.find((id) => !active.has(id));
        if (stray) {
          throw new ConflictError(
            "ITEM_NOT_ACTIVE",
            "a chosen work is not an active work of this order",
            { orderItemId: stray },
          );
        }
      }
      const assessment = await assessFor(tx, c, order, {
        grantFourMonths: input.grantFourMonths,
        orderItemIds: chosen,
      });
      if (!assessment) {
        throw new ConflictError("ORDER_NOT_PAID", "nothing was captured");
      }
      if (assessment.items.length === 0) {
        throw new ConflictError(
          "NO_ITEMS",
          "every work of this notice was already cancelled",
        );
      }
      const feeMinor = clampFee(input.feeMinor, assessment.suggestedFeeMinor);
      const refundAmountMinor = cancellationRefund(assessment, feeMinor);
      const orderItemIds = assessment.items.map((i) => i.id);

      const [shipment] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.orderId, order.id))
        .for("update");
      if (shipment && LABEL_PENDING.includes(shipment.status)) {
        throw new ConflictError(
          "LABEL_PENDING",
          "resolve the pending label request first",
        );
      }
      // A work is cancelled once: the primary key on order_item_id refuses a second row.
      await tx.insert(cancellationItems).values(
        orderItemIds.map((orderItemId) => ({
          orderItemId,
          cancellationId: c.id,
          orderId: order.id,
        })),
      );
      // WS3's hooks: no work left → the parcel that has not left is CANCELLED; otherwise it is
      // repacked for the remaining works (event row, audited, silent).
      const shipped = assessment.final
        ? await cancelShipmentForOrder(tx, order.id, ctx.actor)
        : await removeItemsFromShipment(tx, order.id, ctx.actor);
      const notShipped = !shipped.shipped;
      if (!notShipped) {
        await tx
          .update(cancellationItems)
          .set({ returnStatus: "AWAITING_RETURN", updatedAt: now })
          .where(eq(cancellationItems.cancellationId, c.id));
      }

      let refundId: string | null = null;
      if (notShipped && refundAmountMinor > 0) {
        const { result } = await requestRefund(
          {
            attemptId: order.paidAttemptId,
            amountMinor: refundAmountMinor,
            reason: "CANCELLATION",
            cancellationId: c.id,
            requestedBy: ctx.actor,
            legalDueAt: c.refundDueAt ?? legalRefundDueAt(c.receivedAt),
            feeWithheldMinor: feeMinor,
          },
          tx,
        );
        refundId = result.refundId;
      }

      await transition(
        tx,
        "cancellation",
        c.id,
        ["RECEIVED"],
        "ACCEPTED",
        {
          decidedBy: ctx.actor,
          decidedAt: now,
          decisionReason: input.note?.trim() || null,
          feeMinor,
          refundAmountMinor,
          itemsMinor: assessment.itemsMinor,
          shippingRefundMinor: assessment.shippingRefundMinor,
          refundId,
          windowEndsAt: assessment.window.end,
          withinWindow: assessment.withinWindow,
          returnStatus: notShipped ? "NOT_APPLICABLE" : "AWAITING_RETURN",
          updatedAt: now,
        },
        ctx.actor,
        { ipHash: ctx.ipHash },
      );
      if (!assessment.final) {
        // The remaining works ship: lift the block unless another notice is still open.
        await releaseBlockIfClear(tx, order.id, now);
      }
      // Nothing to refund (or all settled) and no work left: the order is CANCELLED now.
      await cancelOrderIfFullyCancelled(tx, order.id, ctx.actor, now);

      const buyerEmail = order.buyerEmail ?? c.email;
      if (!notShipped && buyerEmail) {
        await enqueueEmail(tx, {
          template: "return-instructions",
          to: buyerEmail,
          locale: order.locale,
          refId: c.id,
        });
      }
      return {
        refundId,
        returnRequired: !notShipped,
        feeMinor,
        refundAmountMinor,
        orderItemIds,
        final: assessment.final,
        pickup: shipped.pickupConfirmation
          ? { orderId: order.id, confirmation: shipped.pickupConfirmation }
          : null,
      };
    },
    { db, name: "cancellation.accept" },
  );
  const { pickup, ...out } = result;
  if (pickup) await cancelBookedPickup(pickup, db);
  return withEffects(out, { outbox: true, revalidate: true });
}

/**
 * A carrier pickup booked for a parcel that will no longer ship: cancelled after commit (never
 * inside the transaction). A failure leaves a WARNING alert for the painter to cancel it by hand.
 */
async function cancelBookedPickup(
  p: { orderId: string; confirmation: string },
  db: DbOrTx,
): Promise<void> {
  const [s] = await db
    .select({ carrier: shipments.carrier })
    .from(shipments)
    .where(eq(shipments.orderId, p.orderId));
  try {
    const adapter = s?.carrier ? carrierAdapter(s.carrier) : null;
    if (!adapter?.cancelPickup)
      throw new Error("carrier cannot cancel pickups");
    await adapter.cancelPickup(p.confirmation);
  } catch (error) {
    log.warn(
      "cancellation.pickup_cancel_failed",
      { orderId: p.orderId },
      error,
    );
    await raiseAlert(
      {
        severity: "WARNING",
        kind: "PICKUP_CANCEL_FAILED",
        dedupeKey: `pickup-cancel:${p.orderId}:${p.confirmation}`,
        entity: "order",
        entityId: p.orderId,
        params: { confirmation: p.confirmation },
      },
      db,
    );
  }
}

/** Requests the cancellation refund later (shipped works: after or before the return). */
export async function refundCancellation(
  ctx: AdminContext,
  cancellationId: string,
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ refundId: string }>> {
  const db = deps.db ?? defaultDb;
  const refundId = await withTx(
    async (tx) => {
      const [head] = await tx
        .select()
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!head?.orderId)
        throw new NotFoundError("cancellation", cancellationId);
      const order = await lockOrder(tx, head.orderId);
      if (!order.paidAttemptId) {
        throw new ConflictError("ORDER_NOT_PAID", "order has no payment");
      }
      const c = await lockCancellation(tx, cancellationId);
      if (c.status !== "ACCEPTED") {
        throw new ConflictError("NOT_ACCEPTED", `notice is ${c.status}`);
      }
      if (c.refundId) {
        throw new ConflictError(
          "REFUND_EXISTS",
          "a refund was already requested",
        );
      }
      const amount = c.refundAmountMinor ?? 0;
      if (amount <= 0)
        throw new ConflictError("NOTHING_TO_REFUND", "amount is 0");
      const { result } = await requestRefund(
        {
          attemptId: order.paidAttemptId,
          amountMinor: amount,
          reason: "CANCELLATION",
          cancellationId: c.id,
          requestedBy: ctx.actor,
          legalDueAt: c.refundDueAt ?? legalRefundDueAt(c.receivedAt),
          feeWithheldMinor: c.feeMinor ?? 0,
        },
        tx,
      );
      await tx
        .update(cancellations)
        .set({ refundId: result.refundId, updatedAt: new Date() })
        .where(eq(cancellations.id, c.id));
      return result.refundId;
    },
    { db, name: "cancellation.refund" },
  );
  return withEffects({ refundId }, { outbox: true, revalidate: true });
}

/** Reject (reason required). Clears the fulfillment block when no other notice is open. */
export async function rejectCancellation(
  ctx: AdminContext,
  cancellationId: string,
  reason: string,
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ rejected: true }>> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  if (!reason.trim())
    throw new ConflictError("REASON_REQUIRED", "reason required");
  await withTx(
    async (tx) => {
      const [head] = await tx
        .select({ orderId: cancellations.orderId })
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!head) throw new NotFoundError("cancellation", cancellationId);
      if (head.orderId) await lockOrder(tx, head.orderId);
      await transition(
        tx,
        "cancellation",
        cancellationId,
        ["RECEIVED"],
        "REJECTED",
        {
          decisionReason: reason.trim(),
          decidedBy: ctx.actor,
          decidedAt: now,
          updatedAt: now,
        },
        ctx.actor,
        { ipHash: ctx.ipHash },
      );
      if (head.orderId) await releaseBlockIfClear(tx, head.orderId, now);
    },
    { db, name: "cancellation.reject" },
  );
  return withEffects({ rejected: true as const }, { revalidate: true });
}

/**
 * Closes a duplicate notice (spec §3.6): only after the admin links it to the original
 * (`duplicate_of_id`), with `decision_reason='DUPLICATE'`.
 */
export async function closeAsDuplicate(
  ctx: AdminContext,
  cancellationId: string,
  duplicateOfNumber: string,
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ closed: true }>> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  await withTx(
    async (tx) => {
      const [original] = await tx
        .select({ id: cancellations.id, orderId: cancellations.orderId })
        .from(cancellations)
        .where(eq(cancellations.number, duplicateOfNumber));
      if (!original) throw new NotFoundError("cancellation", duplicateOfNumber);
      if (original.id === cancellationId) {
        throw new ConflictError(
          "SELF_DUPLICATE",
          "a notice cannot duplicate itself",
        );
      }
      const [head] = await tx
        .select({ orderId: cancellations.orderId })
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!head) throw new NotFoundError("cancellation", cancellationId);
      const orderId = head.orderId ?? original.orderId;
      if (orderId) await lockOrder(tx, orderId);
      await transition(
        tx,
        "cancellation",
        cancellationId,
        ["RECEIVED"],
        "CLOSED",
        {
          duplicateOfId: original.id,
          possibleDuplicate: true,
          decisionReason: "DUPLICATE",
          decidedBy: ctx.actor,
          decidedAt: now,
          closedAt: now,
          updatedAt: now,
        },
        ctx.actor,
        { ipHash: ctx.ipHash, action: "cancellation.closed_duplicate" },
      );
      if (orderId) await releaseBlockIfClear(tx, orderId, now);
    },
    { db, name: "cancellation.duplicate" },
  );
  return withEffects({ closed: true as const }, { revalidate: true });
}

/** The returned works (all of the notice's, one parcel) arrived at the studio. */
export async function recordReturnReceived(
  ctx: AdminContext,
  cancellationId: string,
  input: { tracking?: string },
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ ok: true }>> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const rows = await withTx(
    async (tx) => {
      const updated = await tx
        .update(cancellations)
        .set({
          returnStatus: "RECEIVED",
          returnReceivedAt: now,
          ...(input.tracking ? { returnTracking: input.tracking } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(cancellations.id, cancellationId),
            eq(cancellations.status, "ACCEPTED"),
            eq(cancellations.returnStatus, "AWAITING_RETURN"),
          ),
        )
        .returning({ id: cancellations.id });
      await tx
        .update(cancellationItems)
        .set({ returnStatus: "RECEIVED", updatedAt: now })
        .where(
          and(
            eq(cancellationItems.cancellationId, cancellationId),
            eq(cancellationItems.returnStatus, "AWAITING_RETURN"),
          ),
        );
      return updated;
    },
    { db, name: "cancellation.return_received" },
  );
  if (rows.length === 0) {
    throw new ConflictError("NOT_AWAITING_RETURN", "no return is expected");
  }
  await audit(
    {
      actor: ctx.actor,
      ipHash: ctx.ipHash,
      action: "cancellation.return_received",
      entity: "cancellation",
      entityId: cancellationId,
    },
    db,
  );
  return withEffects({ ok: true as const }, { revalidate: true });
}

/**
 * Inspection of the returned works, per work: `damagedItemIds` names the damaged ones (order item
 * ids of this notice); without it, `damaged` applies to every work. A damaged work is relisted as
 * NOT_FOR_SALE, the others as AVAILABLE. The notice shows INSPECTED_DAMAGED when any work is.
 */
export async function recordInspection(
  ctx: AdminContext,
  cancellationId: string,
  input: {
    damaged: boolean;
    damagedItemIds?: readonly string[];
    notes?: string;
  },
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ ok: true }>> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const rows = await withTx(
    async (tx) => {
      const c = await lockCancellation(tx, cancellationId);
      if (c.returnStatus !== "RECEIVED") return [];
      const items = await tx
        .select({ id: cancellationItems.orderItemId })
        .from(cancellationItems)
        .where(eq(cancellationItems.cancellationId, cancellationId));
      const damaged = new Set(
        input.damagedItemIds ?? (input.damaged ? items.map((i) => i.id) : []),
      );
      const stray = [...damaged].find((id) => !items.some((i) => i.id === id));
      if (stray) {
        throw new ConflictError(
          "ITEM_NOT_IN_NOTICE",
          "the damaged work is not part of this cancellation",
          { orderItemId: stray },
        );
      }
      for (const i of items) {
        await tx
          .update(cancellationItems)
          .set({
            returnStatus: damaged.has(i.id)
              ? "INSPECTED_DAMAGED"
              : "INSPECTED_OK",
            updatedAt: now,
          })
          .where(eq(cancellationItems.orderItemId, i.id));
      }
      const anyDamaged = items.length > 0 ? damaged.size > 0 : input.damaged;
      return tx
        .update(cancellations)
        .set({
          returnStatus: anyDamaged ? "INSPECTED_DAMAGED" : "INSPECTED_OK",
          inspectionNotes: input.notes?.trim() || null,
          updatedAt: now,
        })
        .where(eq(cancellations.id, cancellationId))
        .returning({ id: cancellations.id });
    },
    { db, name: "cancellation.inspect" },
  );
  if (rows.length === 0) {
    throw new ConflictError("NOT_RECEIVED_BACK", "the work is not back yet");
  }
  await audit(
    {
      actor: ctx.actor,
      ipHash: ctx.ipHash,
      action: "cancellation.inspected",
      entity: "cancellation",
      entityId: cancellationId,
      after: {
        damaged: input.damaged,
        damagedItemIds: input.damagedItemIds ?? null,
      },
    },
    db,
  );
  return withEffects({ ok: true as const }, { revalidate: true });
}

const SETTLED = ["SUCCEEDED", "MANUAL_DONE"] as const;
const RETURN_FINAL = [
  "NOT_APPLICABLE",
  "INSPECTED_OK",
  "INSPECTED_DAMAGED",
] as const;

/** ACCEPTED → CLOSED once the refund settled and the return is final (spec §3.6). */
export async function closeCancellation(
  ctx: AdminContext,
  cancellationId: string,
  deps: CancellationDeps = {},
): Promise<ServiceResult<{ closed: true }>> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  await withTx(
    async (tx) => {
      const [head] = await tx
        .select()
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!head) throw new NotFoundError("cancellation", cancellationId);
      if (head.orderId) await lockOrder(tx, head.orderId);
      const c = await lockCancellation(tx, cancellationId);
      const refundOk = await refundSettled(tx, c);
      if (!refundOk) {
        throw new ConflictError(
          "REFUND_NOT_SETTLED",
          "the refund has not settled",
        );
      }
      if (!(RETURN_FINAL as readonly string[]).includes(c.returnStatus)) {
        throw new ConflictError("RETURN_OPEN", `return is ${c.returnStatus}`);
      }
      await transition(
        tx,
        "cancellation",
        c.id,
        ["ACCEPTED"],
        "CLOSED",
        { closedAt: now, updatedAt: now },
        ctx.actor,
        { ipHash: ctx.ipHash },
      );
    },
    { db, name: "cancellation.close" },
  );
  return withEffects({ closed: true as const }, { revalidate: true });
}

/** True when the notice needs no refund (amount 0) or its refund settled. */
async function refundSettled(tx: DbOrTx, c: Cancellation): Promise<boolean> {
  if (!c.refundId) return (c.refundAmountMinor ?? 0) === 0;
  const [r] = await tx
    .select({ status: refunds.status })
    .from(refunds)
    .where(eq(refunds.id, c.refundId));
  return !!r && (SETTLED as readonly string[]).includes(r.status);
}

/**
 * Relist (INSPECTED_OK / NOT_APPLICABLE) or mark damaged (INSPECTED_DAMAGED) the works of an
 * accepted online-sale cancellation once its refund settled and the return is final (spec §3.6,
 * §5.9): only this notice's works — their sales are voided and each goes SOLD → AVAILABLE (or
 * NOT_FOR_SALE when that work was inspected damaged). The order's other works stay sold. Artworks
 * are locked first.
 */
export async function relistAfterCancellation(
  ctx: AdminContext,
  cancellationId: string,
  deps: CancellationDeps = {},
): Promise<
  ServiceResult<{
    artworkIds: string[];
    /** One outcome for every work, or MIXED. */
    to: "AVAILABLE" | "NOT_FOR_SALE" | "MIXED";
    outcomes: { artworkId: string; to: "AVAILABLE" | "NOT_FOR_SALE" }[];
  }>
> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const result = await withTx(
    async (tx) => {
      const [head] = await tx
        .select()
        .from(cancellations)
        .where(eq(cancellations.id, cancellationId));
      if (!head?.orderId)
        throw new NotFoundError("cancellation", cancellationId);
      const items = await itemsOfCancellation(tx, cancellationId);
      await lockArtworks(
        tx,
        items.map((i) => i.artworkId),
      );
      const order = await lockOrder(tx, head.orderId);
      const c = await lockCancellation(tx, cancellationId);
      if (c.status !== "ACCEPTED" && c.status !== "CLOSED") {
        throw new ConflictError("NOT_ACCEPTED", `notice is ${c.status}`);
      }
      if (!(await refundSettled(tx, c))) {
        throw new ConflictError(
          "REFUND_NOT_SETTLED",
          "the refund has not settled",
        );
      }
      if (!(RETURN_FINAL as readonly string[]).includes(c.returnStatus)) {
        throw new ConflictError("RETURN_OPEN", `return is ${c.returnStatus}`);
      }
      const toOf = new Map(
        items.map((i) => [
          i.id,
          i.cancellation?.returnStatus === "INSPECTED_DAMAGED"
            ? ("NOT_FOR_SALE" as const)
            : ("AVAILABLE" as const),
        ]),
      );
      const voided = await tx
        .update(sales)
        .set({
          voidedAt: now,
          voidReason: `CANCELLATION:${c.number}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(sales.orderId, order.id),
            isNull(sales.voidedAt),
            inArray(
              sales.orderItemId,
              items.map((i) => i.id),
            ),
          ),
        )
        .returning({
          artworkId: sales.artworkId,
          orderItemId: sales.orderItemId,
        });
      const outcomes: {
        artworkId: string;
        to: "AVAILABLE" | "NOT_FOR_SALE";
      }[] = [];
      for (const v of voided) {
        const to = toOf.get(v.orderItemId ?? "") ?? "AVAILABLE";
        await transition(
          tx,
          "artwork",
          v.artworkId,
          ["SOLD"],
          to,
          { soldAt: null, updatedAt: now },
          ctx.actor,
          {
            ipHash: ctx.ipHash,
            action: to === "AVAILABLE" ? "artwork.relisted" : "artwork.damaged",
          },
        );
        outcomes.push({ artworkId: v.artworkId, to });
      }
      if (outcomes.length === 0) {
        throw new ConflictError(
          "NOTHING_TO_RELIST",
          "no active sale for this notice's works",
        );
      }
      const kinds = new Set(outcomes.map((o) => o.to));
      return {
        artworkIds: outcomes.map((o) => o.artworkId),
        to:
          kinds.size === 1
            ? (outcomes[0]?.to ?? "AVAILABLE")
            : ("MIXED" as const),
        outcomes,
      };
    },
    { db, name: "cancellation.relist" },
  );
  return withEffects(result, { revalidate: true });
}

// ---------------------------------------------------------------- reads (admin)

export interface CancellationListItem {
  id: string;
  number: string;
  status: Cancellation["status"];
  returnStatus: Cancellation["returnStatus"];
  channel: Cancellation["channel"];
  fullName: string;
  idNumberMasked: string | null;
  orderId: string | null;
  orderNumber: string | null;
  receivedAt: Date;
  refundDueAt: Date | null;
  possibleDuplicate: boolean;
  /** Works of this notice (covered once accepted, else requested); null = the whole order. */
  itemCount: number | null;
  /** Works in the order (0 when unmatched). */
  orderItemCount: number;
}

/** `•••••••12` from the stored last 3 characters (the full number is never decrypted for display). */
export function maskedFromLast3(last3: string | null): string | null {
  return last3 ? `•••••••${last3.slice(-2)}` : null;
}

/** Admin list, sorted by refund due date (spec §6.10). Open notices first. */
export async function listCancellations(
  _ctx: AdminContext,
  opts: {
    status?: Cancellation["status"] | "OPEN" | "ALL";
    limit?: number;
  } = {},
  db: DbOrTx = defaultDb,
): Promise<CancellationListItem[]> {
  const status = opts.status ?? "OPEN";
  const where =
    status === "ALL"
      ? undefined
      : status === "OPEN"
        ? inArray(cancellations.status, [...OPEN_CANCELLATION_STATUSES])
        : eq(cancellations.status, status);
  const rows = await db
    .select({
      c: cancellations,
      orderNumber: orders.number,
      covered: sql<number>`(SELECT count(*)::int FROM cancellation_items ci WHERE ci.cancellation_id = ${cancellations.id})`,
      orderItemCount: sql<number>`(SELECT count(*)::int FROM order_items oi WHERE oi.order_id = ${cancellations.orderId})`,
    })
    .from(cancellations)
    .leftJoin(orders, eq(orders.id, cancellations.orderId))
    .where(where)
    .orderBy(
      sql`CASE WHEN ${cancellations.status} IN ('RECEIVED','ACCEPTED') THEN 0 ELSE 1 END`,
      asc(cancellations.refundDueAt),
      asc(cancellations.receivedAt),
    )
    .limit(opts.limit ?? 200);
  return rows.map(({ c, orderNumber, covered, orderItemCount }) => ({
    id: c.id,
    number: c.number,
    status: c.status,
    returnStatus: c.returnStatus,
    channel: c.channel,
    fullName: c.fullName,
    idNumberMasked: maskedFromLast3(c.idNumberLast3),
    orderId: c.orderId,
    orderNumber: orderNumber ?? c.orderNumberInput,
    receivedAt: c.receivedAt,
    refundDueAt: c.refundDueAt,
    possibleDuplicate: c.possibleDuplicate,
    itemCount:
      covered > 0 ? covered : (c.requestedItemIds?.length ?? null) || null,
    orderItemCount,
  }));
}

export interface CancellationDetail {
  cancellation: Cancellation;
  idNumberMasked: string | null;
  order: Order | null;
  duplicateOf: { id: string; number: string } | null;
  related: { id: string; number: string; status: Cancellation["status"] }[];
  refund: {
    id: string;
    status: string;
    amountMinor: number;
    currency: string;
    legalDueAt: Date | null;
  } | null;
  shipmentStatus: ShipmentStatus | null;
  assessment: Awaited<ReturnType<typeof assessFor>>;
  /** Every work of the order, with this notice's choice and any cancellation that covers it. */
  items: CancellationItemView[];
  /** Inputs of the accept form's live amount preview (open notices on a paid order). */
  preview: AcceptPreview | null;
}

export interface CancellationItemView {
  orderItemId: string;
  artworkId: string;
  titleHe: string;
  titleEn: string;
  priceMinor: number;
  saleStatus: string;
  /** Named by this notice: covered by it once accepted; requested (or the whole order) before. */
  inNotice: boolean;
  /** The accepted cancellation that covers the work (this notice or another). */
  cancelledBy: { id: string; number: string } | null;
  /** The work's return and inspection, when this notice covers it. */
  returnStatus: Cancellation["returnStatus"] | null;
}

/**
 * What the accept form needs to recompute the amounts for any choice of works (pure helpers
 * `cancellationBase`, `changeOfMindFee`, `cancellationRefund` on the client).
 */
export interface AcceptPreview {
  currency: Order["currency"];
  paidMinor: number;
  alreadyRefundedMinor: number;
  orderItemsMinor: number;
  activeItemIds: string[];
  fee: {
    regime: "IL" | "EU";
    reason: NonNullable<Cancellation["reason"]>;
    policy: "STATUTORY_MAX" | "NONE";
    ilsPerUsd: number | null;
    alreadyWithheldMinor: number;
  };
}

export async function getCancellationDetail(
  _ctx: AdminContext,
  id: string,
  db: DbOrTx = defaultDb,
): Promise<CancellationDetail | null> {
  const [c] = await db
    .select()
    .from(cancellations)
    .where(eq(cancellations.id, id));
  if (!c) return null;
  const [order] = c.orderId
    ? await db.select().from(orders).where(eq(orders.id, c.orderId))
    : [];
  const [dup] = c.duplicateOfId
    ? await db
        .select({ id: cancellations.id, number: cancellations.number })
        .from(cancellations)
        .where(eq(cancellations.id, c.duplicateOfId))
    : [];
  const related = c.orderId
    ? await db
        .select({
          id: cancellations.id,
          number: cancellations.number,
          status: cancellations.status,
        })
        .from(cancellations)
        .where(
          and(eq(cancellations.orderId, c.orderId), ne(cancellations.id, c.id)),
        )
        .orderBy(asc(cancellations.receivedAt))
    : [];
  const [refund] = c.refundId
    ? await db
        .select({
          id: refunds.id,
          status: refunds.status,
          amountMinor: refunds.amountMinor,
          currency: refunds.currency,
          legalDueAt: refunds.legalDueAt,
        })
        .from(refunds)
        .where(eq(refunds.id, c.refundId))
    : [];
  const [shipment] = order
    ? await db
        .select({ status: shipments.status })
        .from(shipments)
        .where(eq(shipments.orderId, order.id))
    : [];
  const stateRows = order ? await orderItemsWithState(db, order.id) : [];
  const saleRows = order
    ? await db.execute<{ id: string; sale_status: string }>(
        sql`SELECT a.id, a.sale_status FROM order_items oi JOIN artworks a ON a.id = oi.artwork_id WHERE oi.order_id = ${order.id}`,
      )
    : { rows: [] };
  const saleOf = new Map(saleRows.rows.map((r) => [r.id, r.sale_status]));
  const requested = c.requestedItemIds ? new Set(c.requestedItemIds) : null;
  const items: CancellationItemView[] = stateRows.map((i) => {
    const mine = i.cancellation?.id === c.id;
    return {
      orderItemId: i.id,
      artworkId: i.artworkId,
      titleHe: i.titleHe,
      titleEn: i.titleEn,
      priceMinor: i.priceMinor,
      saleStatus: saleOf.get(i.artworkId) ?? "",
      inNotice:
        c.status === "ACCEPTED" || c.status === "CLOSED"
          ? mine
          : i.cancellation === null && (!requested || requested.has(i.id)),
      cancelledBy: i.cancellation
        ? { id: i.cancellation.id, number: i.cancellation.number }
        : null,
      returnStatus: mine ? (i.cancellation?.returnStatus ?? null) : null,
    };
  });
  const assessment =
    order && c.status === "RECEIVED"
      ? await assessFor(db, c, order, {
          grantFourMonths: c.eligibleGroup !== "NONE",
          orderItemIds: c.requestedItemIds,
        })
      : null;
  const policy = await getSetting("cancellation_policy", db);
  const preview: AcceptPreview | null =
    order && assessment
      ? {
          currency: order.currency,
          paidMinor: assessment.paidMinor,
          alreadyRefundedMinor: assessment.alreadyRefundedMinor,
          orderItemsMinor: stateRows.reduce((s, i) => s + i.priceMinor, 0),
          activeItemIds: stateRows
            .filter((i) => i.cancellation === null)
            .map((i) => i.id),
          fee: {
            regime: regimeFor(order.shipCountry) ?? c.regime,
            reason: c.reason ?? "OTHER",
            policy: policy.changeOfMindFee,
            ilsPerUsd: order.fxIlsPerUnit ? Number(order.fxIlsPerUnit) : null,
            alreadyWithheldMinor: assessment.feesWithheldMinor,
          },
        }
      : null;
  return {
    cancellation: c,
    idNumberMasked: maskedFromLast3(c.idNumberLast3),
    order: order ?? null,
    duplicateOf: dup ?? null,
    related,
    refund: refund ?? null,
    shipmentStatus: shipment?.status ?? null,
    assessment,
    items,
    preview,
  };
}

/**
 * The buyer's review step (public `/cancel`): when the notice names an order number and the name
 * or email matches that order (the auto-match rule), the works still active, so the buyer can
 * choose which to cancel. Empty for an order with a single work, or when nothing matches. Read only.
 */
export async function previewCancellableItems(
  notice: Pick<CancellationNotice, "orderNumber" | "email" | "fullName">,
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<{ id: string; title: string }[]> {
  if (!notice.orderNumber) return [];
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.number, notice.orderNumber));
  if (!order || (order.status !== "PAID" && order.status !== "COMPLETED")) {
    return [];
  }
  if (
    !identityMatches(
      { email: notice.email ?? null, fullName: notice.fullName },
      order,
    )
  ) {
    return [];
  }
  const active = await activeOrderItems(db, order.id);
  if (active.length < 2) return [];
  return active.map((i) => ({
    id: i.id,
    title: locale === "he" ? i.titleHe : i.titleEn,
  }));
}

/** Open notices whose refund deadline is near or past (daily alerts, dashboard). */
export async function refundDeadlines(
  db: DbOrTx = defaultDb,
): Promise<
  { id: string; number: string; refundDueAt: Date; refundSettled: boolean }[]
> {
  const rows = await db
    .select({
      id: cancellations.id,
      number: cancellations.number,
      refundDueAt: cancellations.refundDueAt,
      refundStatus: refunds.status,
      refundAmountMinor: cancellations.refundAmountMinor,
    })
    .from(cancellations)
    .leftJoin(refunds, eq(refunds.id, cancellations.refundId))
    .where(inArray(cancellations.status, [...OPEN_CANCELLATION_STATUSES]))
    .orderBy(asc(cancellations.refundDueAt));
  return rows
    .filter((r) => r.refundDueAt !== null)
    .map((r) => ({
      id: r.id,
      number: r.number,
      refundDueAt: r.refundDueAt as Date,
      refundSettled:
        (r.refundStatus !== null &&
          (SETTLED as readonly string[]).includes(r.refundStatus)) ||
        (r.refundStatus === null && r.refundAmountMinor === 0),
    }));
}
