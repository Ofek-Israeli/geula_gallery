import "server-only";
import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { audit, auditBy } from "@/server/audit";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  adminAlerts,
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
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { NotFoundError } from "@/server/domain/errors";
import type { OrderStatus } from "@/server/domain/state-machines";
import {
  type FinalizeResult,
  finalizeAttempt,
} from "@/server/payments/finalize";
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
  const firstItem = sql<
    string | null
  >`(SELECT oi.title_he FROM order_items oi WHERE oi.order_id = ${orders.id} ORDER BY oi.created_at LIMIT 1)`;
  const firstItemEn = sql<
    string | null
  >`(SELECT oi.title_en FROM order_items oi WHERE oi.order_id = ${orders.id} ORDER BY oi.created_at LIMIT 1)`;
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
