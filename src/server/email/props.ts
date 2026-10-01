import "server-only";
import { asc, eq } from "drizzle-orm";
import type {
  EmailTemplateId,
  EmailTemplateProps,
  NotCompletedReason,
} from "@/emails";
import type { Locale } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  type Order,
  orderItems,
  orders,
  paymentAttempts,
  refunds,
  shipments,
  taxDocuments,
} from "@/server/db/schema";
import { buyerOrderUrls, loadDisclosure } from "@/server/documents/data";
import { NotFoundError, notImplemented } from "@/server/domain/errors";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  painterNewRequestEmail,
  requestAckEmail,
  requestReplyEmail,
} from "@/server/requests/service";
import { getSetting } from "@/server/settings";

/**
 * Fresh props for each email template (spec §5.4 `SEND_EMAIL`: "render fresh data in
 * `orders.locale`"). The outbox payload carries only `{ template, to, locale, refId }`; each builder
 * loads what its template shows at send time. `refId` is the entity in the dedupe key:
 *
 * | template | refId |
 * |---|---|
 * | order-confirmation, painter-new-order | order id |
 * | payment-review, purchase-not-completed | payment attempt id |
 * | refund-issued | refund id |
 * | receipt | tax document id |
 * | checkout-link | order id |
 * | shipment-update | `<shipmentId>:<status>` |
 * | ready-for-pickup | shipment id |
 *
 * Templates whose flows land in later streams (requests, cancellations, links, pickup, alerts)
 * throw `NotImplementedError` naming the owner, who adds the builder here.
 */
export interface BuiltEmail<K extends EmailTemplateId> {
  props: EmailTemplateProps[K];
  /** Buyer templates: the order's own locale (painter templates are rendered in Hebrew anyway). */
  locale: Locale;
  orderId: string | null;
}

export interface BuildDeps {
  db?: DbOrTx;
  env?: Env;
}

type Builders = {
  [K in EmailTemplateId]: (
    refId: string,
    locale: Locale,
    deps: Required<BuildDeps>,
  ) => Promise<BuiltEmail<K>>;
};

async function orderById(db: DbOrTx, id: string): Promise<Order> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) throw new NotFoundError("order", id);
  return order;
}

async function moneyLines(db: DbOrTx, order: Order, locale: Locale) {
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.createdAt));
  return items.map((i) => ({
    title: locale === "he" ? i.titleHe : i.titleEn,
    amountMinor: i.priceMinor,
  }));
}

function orderRef(order: Order, locale: Locale, env: Env) {
  return {
    orderNumber: order.number,
    buyerName: order.buyerName ?? "",
    orderUrl: buyerOrderUrls(order, locale, env).orderUrl,
  };
}

async function attemptAndOrder(db: DbOrTx, attemptId: string) {
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId));
  if (!attempt) throw new NotFoundError("payment_attempt", attemptId);
  return { attempt, order: await orderById(db, attempt.orderId) };
}

const NOT_COMPLETED: readonly NotCompletedReason[] = [
  "LOST_RESERVATION",
  "DUPLICATE_PAYMENT",
  "STALE_QUOTE",
  "ORDER_CANCELLED",
  "AMOUNT_MISMATCH",
];

const later = (owner: string) => async (): Promise<never> =>
  notImplemented("email props builder", owner);

export const EMAIL_PROPS: Builders = {
  "order-confirmation": async (refId, _locale, { db, env }) => {
    const order = await orderById(db, refId);
    const locale = order.locale;
    const urls = buyerOrderUrls(order, locale, env);
    return {
      locale,
      orderId: order.id,
      props: {
        ...orderRef(order, locale, env),
        items: await moneyLines(db, order, locale),
        currency: order.currency,
        shippingMinor: order.shippingMinor,
        insuranceMinor: order.insuranceMinor,
        totalMinor: order.totalMinor,
        paidAt: (order.paidAt ?? order.updatedAt).toISOString(),
        disclosure: await loadDisclosure(order, locale, { db, env }),
        disclosureUrl: urls.disclosureUrl,
      },
    };
  },

  "painter-new-order": async (refId, _locale, { db, env }) => {
    const order = await orderById(db, refId);
    return {
      locale: "he",
      orderId: order.id,
      props: {
        orderNumber: order.number,
        adminOrderUrl: absoluteUrl(
          env.APP_URL,
          localePath("he", paths.admin.order(order.id)),
        ),
        buyerName: order.buyerName ?? "",
        buyerCountry: order.shipCountry,
        items: await moneyLines(db, order, "he"),
        totalMinor: order.totalMinor,
        currency: order.currency,
        isDemo: order.isDemo,
      },
    };
  },

  "payment-review": async (refId, _locale, { db, env }) => {
    const { order } = await attemptAndOrder(db, refId);
    return {
      locale: order.locale,
      orderId: order.id,
      props: orderRef(order, order.locale, env),
    };
  },

  "purchase-not-completed": async (refId, _locale, { db, env }) => {
    const { attempt, order } = await attemptAndOrder(db, refId);
    const rows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.attemptId, attempt.id))
      .orderBy(asc(refunds.createdAt));
    const own = rows.filter((r) => r.reason !== "EXTERNAL");
    const fromRefund = own
      .map((r): string => r.reason)
      .find((r): r is NotCompletedReason =>
        (NOT_COMPLETED as readonly string[]).includes(r),
      );
    const charged =
      attempt.status === "NEEDS_REFUND" ||
      attempt.status === "REFUNDED" ||
      own.length > 0;
    const counted = own.filter(
      (r) => !(r.status === "FAILED" && r.failureConfirmedAt),
    );
    const refundAmountMinor = counted.reduce((s, r) => s + r.amountMinor, 0);
    return {
      locale: order.locale,
      orderId: order.id,
      props: {
        ...orderRef(order, order.locale, env),
        reason:
          fromRefund ?? (charged ? "LOST_RESERVATION" : "LOST_BEFORE_CAPTURE"),
        charged,
        ...(charged && refundAmountMinor > 0 ? { refundAmountMinor } : {}),
        currency: attempt.currency,
      },
    };
  },

  "refund-issued": async (refId, _locale, { db, env }) => {
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, refId));
    if (!refund) throw new NotFoundError("refund", refId);
    const order = await orderById(db, refund.orderId);
    const [note] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.refundId, refund.id));
    return {
      locale: order.locale,
      orderId: order.id,
      props: {
        ...orderRef(order, order.locale, env),
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        ...(note?.status === "ISSUED" && note.docNumber
          ? {
              creditNoteUrl:
                note.docUrl ??
                buyerOrderUrls(order, order.locale, env).receiptUrl(
                  note.docNumber,
                ),
            }
          : {}),
      },
    };
  },

  receipt: async (refId, _locale, { db, env }) => {
    const [doc] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.id, refId));
    if (!doc?.docNumber) throw new NotFoundError("tax_document", refId);
    const order = await orderById(db, doc.orderId);
    return {
      locale: order.locale,
      orderId: order.id,
      props: {
        ...orderRef(order, order.locale, env),
        docNumber: doc.docNumber,
        docUrl:
          doc.docUrl ??
          buyerOrderUrls(order, order.locale, env).receiptUrl(doc.docNumber),
        isDemoDocument: doc.provider === "MOCK",
      },
    };
  },

  "shipment-update": async (refId, _locale, { db, env }) => {
    const [shipmentId = "", status = ""] = refId.split(":");
    const [shipment] = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId));
    if (!shipment) throw new NotFoundError("shipment", shipmentId);
    const order = await orderById(db, shipment.orderId);
    return {
      locale: order.locale,
      orderId: order.id,
      props: {
        ...orderRef(order, order.locale, env),
        status: (status || shipment.status) as ShipmentStatus,
        carrierName: shipment.carrierName ?? shipment.carrier ?? "",
        ...(shipment.trackingNumber
          ? { trackingNumber: shipment.trackingNumber }
          : {}),
        ...(shipment.trackingUrl ? { trackingUrl: shipment.trackingUrl } : {}),
        ...(shipment.estimatedDeliveryAt
          ? { estimatedDeliveryAt: shipment.estimatedDeliveryAt.toISOString() }
          : {}),
        dhlAttribution: shipment.carrier === "DHL",
      },
    };
  },

  // WS3: the pickup address is revealed here (refId = shipment id).
  "ready-for-pickup": async (refId, _locale, { db, env }) => {
    const [shipment] = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, refId));
    if (!shipment) throw new NotFoundError("shipment", refId);
    const order = await orderById(db, shipment.orderId);
    const profile = await getSetting("business_profile", db);
    return {
      locale: order.locale,
      orderId: order.id,
      props: {
        ...orderRef(order, order.locale, env),
        pickupAddress: profile.pickupAddress[order.locale],
        pickupInstructions: profile.pickupInstructions[order.locale],
      },
    };
  },
  "checkout-link": async (refId, _locale, { db, env }) => {
    // refId = the link order (spec §5.8). Fresh: the total after any requote, the live hold.
    const order = await orderById(db, refId);
    const locale = order.locale;
    const [first] = await moneyLines(db, order, locale);
    const ref = orderRef(order, locale, env);
    return {
      locale,
      orderId: order.id,
      props: {
        ...ref,
        artworkTitle: first?.title ?? "",
        payUrl: ref.orderUrl,
        expiresAt: (order.expiresAt ?? order.createdAt).toISOString(),
        totalMinor: order.totalMinor,
        currency: order.currency,
      },
    };
  },
  "request-ack": (refId, _locale, { db }) => requestAckEmail(refId, db),
  "request-reply": (refId, _locale, { db }) => requestReplyEmail(refId, db),
  "cancellation-ack": later("WS6"),
  "return-instructions": later("WS6"),
  "painter-new-request": (refId, _locale, { db, env }) =>
    painterNewRequestEmail(refId, db, env),
  "painter-cancellation": later("WS6"),
  "admin-alert": later("WS6"),
};

export async function buildEmail<K extends EmailTemplateId>(
  template: K,
  refId: string,
  locale: Locale,
  deps: BuildDeps = {},
): Promise<BuiltEmail<K>> {
  const builder = EMAIL_PROPS[template] as Builders[K];
  return builder(refId, locale, {
    db: deps.db ?? defaultDb,
    env: deps.env ?? defaultEnv,
  });
}
