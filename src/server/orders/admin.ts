import "server-only";
import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { audit, auditBy } from "@/server/audit";
import {
  type CreateLinkOrderInput,
  createLinkOrder,
} from "@/server/checkout/links";
import { releaseReservation } from "@/server/checkout/release";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  adminAlerts,
  artworks,
  auditLog,
  emailMessages,
  type Order,
  orderItems,
  orders,
  type PaymentAttempt,
  paymentAttempts,
  type Refund,
  refunds,
  type Shipment,
  shipments,
  type TaxDocument,
  taxDocuments,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import type { OrderStatus, RefundStatus } from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { enqueue } from "@/server/outbox/enqueue";
import { dedupeKeys } from "@/server/outbox/types";
import {
  type FinalizeResult,
  finalizeAttempt,
} from "@/server/payments/finalize";
import {
  type OfflinePaymentInput,
  recordOfflinePayment,
} from "@/server/payments/offline";
import {
  confirmManualRefund,
  confirmRefundFailure,
  countedRefundsMinor,
  lockChain,
  reconcileRefund,
  requestRefund,
  retryRefund,
} from "@/server/payments/refunds";
import { orderAccessToken } from "@/server/security/tokens";

/**
 * Admin order reads and the "Recheck payment" action (spec §6.10 `/admin/orders`, `/[id]`). Every
 * function takes `ctx: AdminContext` (buyer PII), which only `requireAdmin()` can produce. M2 builds
 * the list, the detail and Recheck; WS4 adds refunds dialogs, documents actions, record payment and
 * the manual order; WS3 the fulfillment screen.
 */
export const ADMIN_ORDERS_PAGE_SIZE = 50;

export interface AdminOrderRow {
  id: string;
  number: string;
  createdAt: Date;
  status: OrderStatus;
  source: Order["source"];
  isDemo: boolean;
  buyerName: string | null;
  buyerEmail: string | null;
  shipCountry: string;
  totalMinor: number;
  currency: Order["currency"];
  titleHe: string | null;
  titleEn: string | null;
}

export async function listAdminOrders(
  _ctx: AdminContext,
  opts: { status?: OrderStatus; page?: number; q?: string } = {},
  db: DbOrTx = defaultDb,
): Promise<{ rows: AdminOrderRow[]; total: number; page: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const q = opts.q?.trim();
  const where = and(
    opts.status ? eq(orders.status, opts.status) : undefined,
    q
      ? or(
          sql`${orders.number} ILIKE ${`%${q}%`}`,
          sql`lower(${orders.buyerEmail}) LIKE ${`%${q.toLowerCase()}%`}`,
          sql`${orders.buyerName} ILIKE ${`%${q}%`}`,
        )
      : undefined,
  );
  // The outer column is written out qualified: Drizzle renders `${orders.id}` in a single-table
  // select list as a bare "id", which inside this subquery would resolve to `oi.id`.
  const firstItem = sql<
    string | null
  >`(SELECT oi.title_he FROM order_items oi WHERE oi.order_id = "orders"."id" ORDER BY oi.created_at LIMIT 1)`;
  const firstItemEn = sql<
    string | null
  >`(SELECT oi.title_en FROM order_items oi WHERE oi.order_id = "orders"."id" ORDER BY oi.created_at LIMIT 1)`;
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      createdAt: orders.createdAt,
      status: orders.status,
      source: orders.source,
      isDemo: orders.isDemo,
      buyerName: orders.buyerName,
      buyerEmail: orders.buyerEmail,
      shipCountry: orders.shipCountry,
      totalMinor: orders.totalMinor,
      currency: orders.currency,
      titleHe: firstItem,
      titleEn: firstItemEn,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(ADMIN_ORDERS_PAGE_SIZE)
    .offset((page - 1) * ADMIN_ORDERS_PAGE_SIZE);
  const [total] = await db.select({ n: count() }).from(orders).where(where);
  return { rows, total: total?.n ?? 0, page };
}

export interface AdminOrderDetail {
  order: Order;
  /** Buyer order page token, for "open as buyer" and the buyer printables. */
  buyerToken: string;
  items: (typeof orderItems.$inferSelect)[];
  attempts: PaymentAttempt[];
  refunds: Refund[];
  taxDocuments: TaxDocument[];
  shipment: Shipment | null;
  emails: {
    id: string;
    template: string;
    toEmail: string;
    status: string;
    sentAt: Date | null;
    createdAt: Date;
  }[];
  timeline: {
    id: number;
    at: Date;
    actor: string;
    action: string;
    entity: string;
  }[];
  alerts: {
    id: string;
    severity: string;
    kind: string;
    createdAt: Date;
    acknowledgedAt: Date | null;
  }[];
}

export async function getAdminOrder(
  _ctx: AdminContext,
  orderId: string,
  db: DbOrTx = defaultDb,
): Promise<AdminOrderDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [items, attempts, refundRows, docs, [shipment], emails, alerts] = [
    await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.createdAt)),
    await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, order.id))
      .orderBy(asc(paymentAttempts.seq)),
    await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, order.id))
      .orderBy(asc(refunds.createdAt)),
    await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.orderId, order.id))
      .orderBy(asc(taxDocuments.createdAt)),
    await db.select().from(shipments).where(eq(shipments.orderId, order.id)),
    await db
      .select({
        id: emailMessages.id,
        template: emailMessages.template,
        toEmail: emailMessages.toEmail,
        status: emailMessages.status,
        sentAt: emailMessages.sentAt,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(eq(emailMessages.orderId, order.id))
      .orderBy(asc(emailMessages.createdAt)),
    await db
      .select({
        id: adminAlerts.id,
        severity: adminAlerts.severity,
        kind: adminAlerts.kind,
        createdAt: adminAlerts.createdAt,
        acknowledgedAt: adminAlerts.acknowledgedAt,
      })
      .from(adminAlerts)
      .where(eq(adminAlerts.entityId, order.id))
      .orderBy(asc(adminAlerts.createdAt)),
  ];
  const entityIds = [
    order.id,
    ...attempts.map((a) => a.id),
    ...refundRows.map((r) => r.id),
    ...docs.map((d) => d.id),
    ...(shipment ? [shipment.id] : []),
  ];
  const timeline = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actor: auditLog.actor,
      action: auditLog.action,
      entity: auditLog.entity,
    })
    .from(auditLog)
    .where(inArray(auditLog.entityId, entityIds))
    .orderBy(asc(auditLog.at), asc(auditLog.id))
    .limit(200);
  return {
    order,
    buyerToken: orderAccessToken(order.id, order.accessVersion),
    items,
    attempts,
    refunds: refundRows,
    taxDocuments: docs,
    shipment: shipment ?? null,
    emails,
    timeline,
    alerts,
  };
}

/**
 * "Recheck payment" (spec §1.1.2, §6.10): the admin is the fourth caller of the one idempotent
 * `finalizeAttempt()`. It re-queries the provider with no locks held and applies the verified
 * result; on a final attempt it is a no-op (`already_final`).
 */
export async function recheckPayment(
  attemptId: string,
  ctx: AdminContext,
): Promise<ServiceResult<FinalizeResult>> {
  const [attempt] = await defaultDb
    .select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId));
  if (!attempt) throw new NotFoundError("payment_attempt", attemptId);
  const out = await finalizeAttempt(attemptId, { trigger: "admin" });
  await audit({
    ...auditBy(ctx),
    action: "payment.rechecked",
    entity: "payment_attempt",
    entityId: attemptId,
    after: {
      outcome: out.result.outcome,
      attemptStatus: out.result.attemptStatus,
    },
  });
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

// ---------------------------------------------------------------- WS4: money and document actions

/** Captured-and-not-yet-(possibly)-refunded amount of each attempt (the refund dialog's cap). */
export function refundableByAttempt(
  attempts: readonly PaymentAttempt[],
  refundRows: readonly Refund[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of attempts) {
    if (!CAPTURED.has(a.status)) continue;
    const rows = refundRows.filter((r) => r.attemptId === a.id);
    out[a.id] = Math.max(0, a.amountMinor - countedRefundsMinor(rows));
  }
  return out;
}

const CAPTURED = new Set<PaymentAttempt["status"]>([
  "SUCCEEDED",
  "NEEDS_REFUND",
  "REFUNDED",
]);

/**
 * Admin-initiated refund from the order page (spec §5.7 step 8, §6.10 "refund dialog (refundable
 * amount, fresh session)"): `requestRefund` with reason ADMIN under the cap. The action asks for a
 * fresh session. The note is audited, never sent to the provider.
 */
export async function adminRefund(
  ctx: AdminContext,
  input: { attemptId: string; amountMinor: number; note: string | null },
): Promise<ServiceResult<{ refundId: string }>> {
  const out = await requestRefund({
    attemptId: input.attemptId,
    amountMinor: input.amountMinor,
    reason: "ADMIN",
    requestedBy: ctx.actor,
  });
  await audit({
    ...auditBy(ctx),
    action: "refund.admin_requested",
    entity: "refund",
    entityId: out.result.refundId,
    after: { amountMinor: input.amountMinor, note: input.note },
  });
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/** MANUAL_REQUIRED → MANUAL_DONE with the reference from the provider dashboard or bank. */
export async function markRefundDone(
  ctx: AdminContext,
  refundId: string,
  reference: string,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const out = await confirmManualRefund(refundId, reference, ctx);
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/** FAILED: "confirmed in the provider dashboard that no money moved" (stops counting in the cap). */
export async function confirmRefundFailed(
  ctx: AdminContext,
  refundId: string,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const out = await confirmRefundFailure(refundId, ctx);
  return withEffects(out.result, { revalidate: true });
}

/** Confirmed FAILED → REQUESTED with a new idempotency key. */
export async function retryFailedRefund(
  ctx: AdminContext,
  refundId: string,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const out = await retryRefund(refundId, ctx.actor);
  await audit({
    ...auditBy(ctx),
    action: "refund.retry_requested",
    entity: "refund",
    entityId: refundId,
  });
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/** PROVIDER_PENDING / UNKNOWN: ask the provider again (`getRefund`), never re-refund. */
export async function recheckRefund(
  ctx: AdminContext,
  refundId: string,
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const out = await reconcileRefund(refundId);
  await audit({
    ...auditBy(ctx),
    action: "refund.rechecked",
    entity: "refund",
    entityId: refundId,
    after: { status: out.result.status },
  });
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/**
 * UNKNOWN resolved by the admin after checking the provider dashboard (spec §5.7 step 8.5:
 * "Cardcom: ListTransactions when an ApiPassword exists, otherwise the admin confirms"):
 * - `refunded` → SUCCEEDED (the reference is stored) and the `refund-settled` job;
 * - `not_refunded` → FAILED with `failure_confirmed_at` set (it stops counting in the cap).
 * Lock order: order → attempt → refund (`lockChain`).
 */
export async function resolveUnknownRefund(
  ctx: AdminContext,
  refundId: string,
  input: { outcome: "refunded" | "not_refunded"; reference: string | null },
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const status = await withTx(
    async (tx) => {
      const [head] = await tx
        .select({ attemptId: refunds.attemptId })
        .from(refunds)
        .where(eq(refunds.id, refundId));
      if (!head) throw new NotFoundError("refund", refundId);
      const { rows } = await lockChain(tx, head.attemptId);
      const row = rows.find((r) => r.id === refundId);
      if (row?.status !== "UNKNOWN") {
        throw new ConflictError(
          "NOT_UNKNOWN",
          "only an UNKNOWN refund can be resolved",
        );
      }
      if (input.outcome === "refunded") {
        const reference = input.reference?.trim();
        if (!reference) {
          throw new ConflictError(
            "REFERENCE_REQUIRED",
            "a reference is required",
          );
        }
        await transition(
          tx,
          "refund",
          refundId,
          ["UNKNOWN"],
          "SUCCEEDED",
          {
            manualReference: reference.slice(0, 200),
            completedAt: new Date(),
            inFlightUntil: null,
            error: null,
          },
          ctx.actor,
          { action: "refund.confirmed_in_dashboard", ipHash: ctx.ipHash },
        );
        await enqueue(tx, {
          kind: "REFUND_SETTLED",
          dedupeKey: dedupeKeys.refundSettled(refundId),
          payload: { refundId },
        });
        return "SUCCEEDED" as const;
      }
      await transition(
        tx,
        "refund",
        refundId,
        ["UNKNOWN"],
        "FAILED",
        {
          failureConfirmedAt: new Date(),
          failureConfirmedBy: ctx.actor,
          inFlightUntil: null,
          error: "confirmed not refunded in the provider dashboard",
        },
        ctx.actor,
        { action: "refund.confirmed_not_refunded", ipHash: ctx.ipHash },
      );
      return "FAILED" as const;
    },
    { name: "refund.resolve_unknown" },
  );
  return withEffects(
    { status },
    { outbox: status === "SUCCEEDED", revalidate: true },
  );
}

/**
 * Tax document FAILED → ISSUING (spec §3.6 "FAILED → ISSUING (admin)"): the row is re-armed with
 * `attempts = 0` (the runner then claims a fresh call) and the issuing job is enqueued again under a
 * new dedupe key, because the original job already finished.
 */
export async function retryTaxDocument(
  ctx: AdminContext,
  taxDocumentId: string,
): Promise<ServiceResult<{ status: "ISSUING" }>> {
  await withTx(
    async (tx) => {
      const [doc] = await tx
        .select()
        .from(taxDocuments)
        .where(eq(taxDocuments.id, taxDocumentId))
        .for("update");
      if (!doc) throw new NotFoundError("tax_document", taxDocumentId);
      if (doc.status !== "FAILED") {
        throw new ConflictError(
          "NOT_FAILED",
          "only a FAILED document can be retried",
        );
      }
      await transition(
        tx,
        "taxDocument",
        doc.id,
        ["FAILED"],
        "ISSUING",
        { attempts: 0, error: null, lastAttemptAt: null },
        ctx.actor,
        { action: "tax_document.retried", ipHash: ctx.ipHash },
      );
      const suffix = `retry:${doc.id}:${Date.now()}`;
      if (doc.kind === "CREDIT_NOTE") {
        if (!doc.refundId)
          throw new ConflictError("NO_REFUND", "credit note without refund");
        await enqueue(tx, {
          kind: "ISSUE_CREDIT_NOTE",
          dedupeKey: `${dedupeKeys.creditNote(doc.refundId)}:${suffix}`,
          payload: { refundId: doc.refundId },
        });
      } else {
        if (!doc.attemptId)
          throw new ConflictError("NO_ATTEMPT", "receipt without attempt");
        await enqueue(tx, {
          kind: "ISSUE_TAX_DOCUMENT",
          dedupeKey: `${dedupeKeys.receipt(doc.attemptId)}:${suffix}`,
          payload: { attemptId: doc.attemptId },
        });
      }
    },
    { name: "taxdoc.retry" },
  );
  return withEffects(
    { status: "ISSUING" as const },
    { outbox: true, revalidate: true },
  );
}

/**
 * NEEDS_MANUAL → ISSUED: the accountant issued the document by hand (e.g. a credit note in gateway
 * mode, or a receipt for an offline payment in a mode that cannot issue it); the admin records its
 * number so the order shows it as documented.
 */
export async function recordManualTaxDocument(
  ctx: AdminContext,
  taxDocumentId: string,
  docNumber: string,
): Promise<ServiceResult<{ status: "ISSUED" }>> {
  const number = docNumber.trim();
  if (!number)
    throw new ConflictError(
      "DOC_NUMBER_REQUIRED",
      "a document number is required",
    );
  await withTx(
    async (tx) => {
      const [doc] = await tx
        .select()
        .from(taxDocuments)
        .where(eq(taxDocuments.id, taxDocumentId))
        .for("update");
      if (!doc) throw new NotFoundError("tax_document", taxDocumentId);
      await transition(
        tx,
        "taxDocument",
        doc.id,
        ["NEEDS_MANUAL"],
        "ISSUED",
        { docNumber: number.slice(0, 64), issuedAt: new Date(), error: null },
        ctx.actor,
        { action: "tax_document.recorded_manually", ipHash: ctx.ipHash },
      );
    },
    { name: "taxdoc.manual" },
  );
  return withEffects({ status: "ISSUED" as const }, { revalidate: true });
}

/** "Record payment received" (spec §5.10): the exact amount, through `recordOfflinePayment` (WS2). */
export async function recordPayment(
  ctx: AdminContext,
  orderId: string,
  input: OfflinePaymentInput,
): Promise<ServiceResult<{ attemptId: string }>> {
  const out = await recordOfflinePayment(orderId, input, ctx);
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/** Releases the hold of an unpaid order (e.g. a link order the buyer will not pay): → EXPIRED (ADMIN). */
export async function cancelUnpaidOrder(
  ctx: AdminContext,
  orderId: string,
): Promise<ServiceResult<{ released: boolean }>> {
  const out = await releaseReservation({
    orderId,
    actor: ctx.actor,
    reason: "ADMIN",
  });
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/** The manual distance order (spec §5.10): `createLinkOrder({ kind: 'MANUAL' })` (WS2 body). */
export async function createManualOrder(
  ctx: AdminContext,
  input: Omit<CreateLinkOrderInput, "kind" | "requestId" | "itemPriceMinor"> & {
    /** Null = the list price in `currency`. */
    itemPriceMinor: number | null;
  },
): Promise<
  ServiceResult<{ orderId: string; orderNumber: string; linkUrl: string }>
> {
  if (input.country === "IL" && input.currency !== "ILS") {
    throw new ConflictError("IL_REQUIRES_ILS", "Israeli orders are in ILS");
  }
  const [artwork] = await defaultDb
    .select({
      priceIlsMinor: artworks.priceIlsMinor,
      priceUsdMinor: artworks.priceUsdMinor,
    })
    .from(artworks)
    .where(eq(artworks.id, input.artworkId));
  if (!artwork) throw new NotFoundError("artwork", input.artworkId);
  const list =
    input.currency === "ILS" ? artwork.priceIlsMinor : artwork.priceUsdMinor;
  const itemPriceMinor = input.itemPriceMinor ?? list;
  if (itemPriceMinor === null) {
    throw new ConflictError("PRICE_REQUIRED", "the work has no list price");
  }
  if (list !== itemPriceMinor && !input.priceChangeReason?.trim()) {
    throw new ConflictError(
      "PRICE_REASON_REQUIRED",
      "a reason is required when the price differs from the list price",
    );
  }
  const out = await createLinkOrder(
    { ...input, itemPriceMinor, kind: "MANUAL" },
    ctx,
  );
  return withEffects(out.result, { ...out.effects, revalidate: true });
}

/** Works the manual order form can sell: AVAILABLE (published or not; the admin may bypass flags). */
export async function listSellableArtworks(
  _ctx: AdminContext,
  db: DbOrTx = defaultDb,
): Promise<
  {
    id: string;
    titleHe: string;
    titleEn: string;
    inventoryNumber: string;
    priceIlsMinor: number | null;
    priceUsdMinor: number | null;
    reservedUntil: Date | null;
  }[]
> {
  return db
    .select({
      id: artworks.id,
      titleHe: artworks.titleHe,
      titleEn: artworks.titleEn,
      inventoryNumber: artworks.inventoryNumber,
      priceIlsMinor: artworks.priceIlsMinor,
      priceUsdMinor: artworks.priceUsdMinor,
      reservedUntil: artworks.reservedUntil,
    })
    .from(artworks)
    .where(eq(artworks.saleStatus, "AVAILABLE"))
    .orderBy(asc(artworks.titleEn));
}
