import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { usdToIls } from "@/lib/money";
import { raiseAlert } from "@/server/alerts/service";
import { audit } from "@/server/audit";
import {
  allSellable,
  expireTakenOverOrders,
  lockArtworks,
  lockAttempt,
  lockOrder,
  orderArtworkIds,
  releaseHoldsOf,
  sellableSql,
} from "@/server/checkout/reservations";
import type { Tx } from "@/server/db/client";
import {
  type Order,
  orderItems,
  type PaymentAttempt,
  paymentAttempts,
  refunds,
  sales,
  shipments,
} from "@/server/db/schema";
import { NotFoundError } from "@/server/domain/errors";
import { commercialInvoiceNumber } from "@/server/domain/ids";
import {
  type AttemptStatus,
  IN_FLIGHT_ATTEMPT_STATUSES,
} from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { enqueue, enqueueEmail } from "@/server/outbox/enqueue";
import { dedupeKeys } from "@/server/outbox/types";
import { getSetting } from "@/server/settings";
import type { ShippingQuoteResult } from "@/server/shipping/types";
import { legalRefundDueAt, requestRefund } from "./refunds";
import type { VerifiedPayment } from "./types";

/**
 * `applySuccessfulPayment()` (spec §5.2 "succeeded"; frozen contract): one short transaction that
 * reads the immutable items, locks artworks (ORDER BY id) → order → attempt, and then either
 * records the sale or routes the verified money to a tracked refund (NEEDS_REFUND):
 *
 * 2. attempt already final → `already_applied`;
 * 3. another attempt of the order CAPTURING / PAYMENT_REVIEW → `deferred` (no state change,
 *    `next_check_at = now()+15 min`, WARNING alert);
 * 4. quote not bound → STALE_QUOTE (the order stays AWAITING_PAYMENT);
 * 5. order PAID/COMPLETED → DUPLICATE_PAYMENT; CANCELLED → ORDER_CANCELLED;
 * 6. a work not sellable → LOST_RESERVATION (order CANCELLED);
 * 7. apply: artworks SOLD (sellable predicate in WHERE, count n), takeover expiry, `sales`
 *    ONLINE, attempt SUCCEEDED, order PAID, shipment row, outbox jobs, audit, INFO alert if late.
 *
 * A 23505 on the sales or winner index aborts the transaction; `finalize.ts` catches it outside
 * and runs `markNeedsRefund` in a new one.
 */
export type NeedsRefundReason =
  | "LOST_RESERVATION"
  | "DUPLICATE_PAYMENT"
  | "ORDER_CANCELLED"
  | "STALE_QUOTE"
  | "AMOUNT_MISMATCH";

export type ApplyOutcome =
  | { kind: "applied"; orderId: string; saleIds: string[]; late: boolean }
  | { kind: "needs_refund"; reason: NeedsRefundReason; refundId: string | null }
  | { kind: "already_applied" }
  | { kind: "deferred" };

/** Statuses from which a verified success / NEEDS_REFUND may be recorded. */
export const NON_FINAL_ATTEMPT_STATUSES = [
  "CREATED",
  "PENDING",
  "AWAITING_CAPTURE",
  "CAPTURING",
  "PAYMENT_REVIEW",
  "EXPIRED",
] as const satisfies readonly AttemptStatus[];

export function isNonFinalAttempt(status: AttemptStatus): boolean {
  return (NON_FINAL_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

/** Quote binding (spec §3.4 layer 5). */
export function quoteBound(
  attempt: Pick<PaymentAttempt, "quoteVersion" | "amountMinor" | "currency">,
  order: Pick<Order, "quoteVersion" | "totalMinor" | "currency">,
): boolean {
  return (
    attempt.quoteVersion === order.quoteVersion &&
    attempt.amountMinor === order.totalMinor &&
    attempt.currency === order.currency
  );
}

/** The verified payment details stored on the attempt (redacted raw payload). */
export function paymentDetails(vp: VerifiedPayment) {
  return {
    transactionId: vp.transactionId ?? null,
    captureId: vp.captureId ?? null,
    method: vp.method ?? null,
    installments: vp.installments ?? null,
    cardLast4: vp.last4 ?? null,
    cardBrand: vp.brand ?? null,
    isForeignCard: vp.isForeignCard ?? null,
    approvalCode: vp.approvalCode ?? null,
    verifiedRaw: vp.rawRedacted ?? null,
  };
}

export interface LockedPaymentContext {
  attempt: PaymentAttempt;
  order: Order;
  artworkIds: string[];
  locked: Awaited<ReturnType<typeof lockArtworks>>;
}

/** Items (no lock) → artworks ORDER BY id → order → attempt (spec §2.2). */
export async function lockPaymentContext(
  tx: Tx,
  attemptId: string,
): Promise<LockedPaymentContext> {
  const [head] = await tx
    .select({ orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId));
  if (!head) throw new NotFoundError("payment_attempt", attemptId);
  const artworkIds = await orderArtworkIds(tx, head.orderId);
  const locked = await lockArtworks(tx, artworkIds);
  const order = await lockOrder(tx, head.orderId);
  if (!order) throw new NotFoundError("order", head.orderId);
  const attempt = await lockAttempt(tx, attemptId);
  if (!attempt) throw new NotFoundError("payment_attempt", attemptId);
  return { attempt, order, artworkIds, locked };
}

/** Another attempt of the same order is CAPTURING or PAYMENT_REVIEW. */
export async function otherAttemptInFlight(
  tx: Tx,
  attempt: Pick<PaymentAttempt, "id" | "orderId">,
): Promise<boolean> {
  const rows = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, attempt.orderId),
        ne(paymentAttempts.id, attempt.id),
        inArray(paymentAttempts.status, [...IN_FLIGHT_ATTEMPT_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function applySuccessfulPayment(
  tx: Tx,
  input: { attemptId: string; verified: VerifiedPayment; actor: string },
): Promise<ApplyOutcome> {
  const ctx = await lockPaymentContext(tx, input.attemptId);
  const { attempt, order, artworkIds, locked } = ctx;
  const now = new Date();

  if (!isNonFinalAttempt(attempt.status)) return { kind: "already_applied" };

  if (await otherAttemptInFlight(tx, attempt)) {
    await tx
      .update(paymentAttempts)
      .set({
        nextCheckAt: new Date(now.getTime() + 15 * 60_000),
        lastCheckedAt: now,
      })
      .where(eq(paymentAttempts.id, attempt.id));
    await raiseAlert(
      {
        severity: "WARNING",
        kind: "PAYMENT_DEFERRED",
        dedupeKey: `payment-deferred:${attempt.id}`,
        entity: "payment_attempt",
        entityId: attempt.id,
        params: { orderNumber: order.number },
      },
      tx,
    );
    return { kind: "deferred" };
  }

  const amountMinor = input.verified.amount?.amountMinor ?? attempt.amountMinor;
  const refund = (reason: NeedsRefundReason) =>
    markNeedsRefund(tx, ctx, {
      reason,
      verified: input.verified,
      amountMinor: amountMinor - (input.verified.refundedMinor ?? 0),
      actor: input.actor,
    });

  if (!quoteBound(attempt, order)) return refund("STALE_QUOTE");
  if (order.status === "PAID" || order.status === "COMPLETED") {
    return refund("DUPLICATE_PAYMENT");
  }
  if (order.status === "CANCELLED") return refund("ORDER_CANCELLED");
  if (!(await allSellable(tx, locked, order.id, now))) {
    return refund("LOST_RESERVATION");
  }

  // 7. Apply.
  const late =
    order.status === "EXPIRED" ||
    attempt.status === "EXPIRED" ||
    (order.expiresAt !== null && order.expiresAt.getTime() < now.getTime());
  for (const a of locked) {
    await transition(
      tx,
      "artwork",
      a.id,
      ["AVAILABLE"],
      "SOLD",
      { soldAt: now, reservedByOrderId: null, reservedUntil: null },
      input.actor,
      { where: sellableSql(order.id), action: "artwork.sold_online" },
    );
  }
  await expireTakenOverOrders(
    tx,
    locked.map((a) => a.reservedByOrderId),
    order.id,
  );
  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const saleRows = await tx
    .insert(sales)
    .values(
      items.map((i) => ({
        artworkId: i.artworkId,
        orderId: order.id,
        orderItemId: i.id,
        channel: "ONLINE" as const,
        priceMinor: i.priceMinor,
        currency: i.currency,
        isMock: attempt.providerMode === "MOCK",
        soldAt: now,
        createdBy: input.actor,
      })),
    )
    .returning({ id: sales.id });
  await transition(
    tx,
    "attempt",
    attempt.id,
    [attempt.status],
    "SUCCEEDED",
    {
      ...paymentDetails(input.verified),
      finalizedAt: now,
      lastCheckedAt: now,
      nextCheckAt: null,
    },
    input.actor,
  );
  await transition(
    tx,
    "order",
    order.id,
    ["AWAITING_PAYMENT", "EXPIRED", "PAYMENT_REVIEW"],
    "PAID",
    {
      paidAttemptId: attempt.id,
      paidAt: now,
      statusReason: null,
      fulfillmentBlockedReason: null,
    },
    input.actor,
  );
  await insertShipment(tx, order);

  const profile = await getSetting("business_profile", tx);
  if (order.buyerEmail) {
    await enqueueEmail(tx, {
      template: "order-confirmation",
      to: order.buyerEmail,
      locale: order.locale,
      refId: order.id,
    });
  }
  await enqueueEmail(tx, {
    template: "painter-new-order",
    to: profile.notificationEmail,
    locale: "he",
    refId: order.id,
  });
  await enqueue(tx, {
    kind: "ISSUE_TAX_DOCUMENT",
    dedupeKey: dedupeKeys.receipt(attempt.id),
    payload: { attemptId: attempt.id },
  });
  if (late) {
    await raiseAlert(
      {
        severity: "INFO",
        kind: "LATE_PAYMENT_APPLIED",
        dedupeKey: `late-payment:${attempt.id}`,
        entity: "order",
        entityId: order.id,
        params: { orderNumber: order.number },
      },
      tx,
    );
  }
  await audit(
    {
      actor: input.actor,
      action: "payment.applied",
      entity: "order",
      entityId: order.id,
      after: {
        attemptId: attempt.id,
        artworkIds,
        totalMinor: order.totalMinor,
        currency: order.currency,
        late,
      },
    },
    tx,
  );
  return {
    kind: "applied",
    orderId: order.id,
    saleIds: saleRows.map((s) => s.id),
    late,
  };
}

async function insertShipment(tx: Tx, order: Order): Promise<void> {
  const quote = (order.shippingQuote ?? null) as ShippingQuoteResult | null;
  const international = order.shipCountry !== "IL";
  let exportDecl: "NOT_REQUIRED" | "REQUIRED" = "NOT_REQUIRED";
  if (international) {
    const [shipping, checkout] = await Promise.all([
      getSetting("shipping", tx),
      getSetting("checkout", tx),
    ]);
    const fx = checkout.fx.ilsPerUsd;
    const valueIls =
      order.currency === "ILS"
        ? order.itemsTotalMinor
        : usdToIls(order.itemsTotalMinor, fx);
    const thresholdIls = usdToIls(
      Math.round(shipping.thresholds.exportDeclarationUsd * 100),
      fx,
    );
    if (valueIls > thresholdIls) exportDecl = "REQUIRED";
  }
  await tx
    .insert(shipments)
    .values({
      orderId: order.id,
      method: order.shippingMethod,
      carrier: quote?.carrier ?? null,
      declaredValueMinor: order.itemsTotalMinor,
      declaredCurrency: order.currency,
      insuredValueMinor: quote?.insured ? quote.insuredValueMinor : null,
      insurancePremiumMinor: quote?.insured ? order.insuranceMinor : null,
      hsCode: "9701.91",
      originCountry: "IL",
      ...(international
        ? {
            incoterm: "DAP",
            reasonForExport: "permanent",
            commercialInvoiceNumber: commercialInvoiceNumber(order.number),
          }
        : {}),
      exportDeclStatus: exportDecl,
      chargedToBuyerMinor: order.shippingMinor + order.insuranceMinor,
    })
    .onConflictDoNothing({ target: shipments.orderId });
}

/**
 * The NEEDS_REFUND transaction body (spec §5.2): attempt → NEEDS_REFUND with the payment details;
 * a REQUESTED refund for the received amount plus its `REFUND_PAYMENT` job (AMOUNT_MISMATCH: a
 * MANUAL_REQUIRED row, no job, no automatic provider call); the receipt job (per
 * `receiptForRefundedPayments`, never for AMOUNT_MISMATCH); the `purchase-not-completed` email; a
 * CRITICAL alert. LOST_RESERVATION also cancels the order and clears its holds. The caller holds
 * the artworks → order → attempt locks.
 */
export async function markNeedsRefund(
  tx: Tx,
  ctx: LockedPaymentContext,
  i: {
    reason: NeedsRefundReason;
    verified: VerifiedPayment;
    amountMinor: number;
    actor: string;
  },
): Promise<ApplyOutcome> {
  const { attempt, order } = ctx;
  const now = new Date();
  if (!isNonFinalAttempt(attempt.status)) return { kind: "already_applied" };
  const currency = i.verified.amount?.currency ?? attempt.currency;

  await transition(
    tx,
    "attempt",
    attempt.id,
    [attempt.status],
    "NEEDS_REFUND",
    {
      ...paymentDetails(i.verified),
      failureReason: i.reason,
      finalizedAt: now,
      lastCheckedAt: now,
      nextCheckAt: null,
    },
    i.actor,
  );

  let refundId: string | null = null;
  if (i.amountMinor > 0) {
    if (i.reason === "AMOUNT_MISMATCH") {
      const [row] = await tx
        .insert(refunds)
        .values({
          attemptId: attempt.id,
          orderId: order.id,
          amountMinor: i.amountMinor,
          currency,
          reason: "AMOUNT_MISMATCH",
          status: "MANUAL_REQUIRED",
          idemKey: randomUUID(),
          requestedBy: i.actor,
          legalDueAt: legalRefundDueAt(now),
          error: "verification mismatch: refund by hand after investigating",
        })
        .returning({ id: refunds.id });
      refundId = row?.id ?? null;
    } else {
      const { result } = await requestRefund(
        {
          attemptId: attempt.id,
          amountMinor: i.amountMinor,
          reason: i.reason,
          requestedBy: i.actor,
          legalDueAt: legalRefundDueAt(now),
        },
        tx,
      );
      refundId = result.refundId;
    }
  }

  const checkout = await getSetting("checkout", tx);
  if (i.reason !== "AMOUNT_MISMATCH" && checkout.receiptForRefundedPayments) {
    await enqueue(tx, {
      kind: "ISSUE_TAX_DOCUMENT",
      dedupeKey: dedupeKeys.receipt(attempt.id),
      payload: { attemptId: attempt.id },
    });
  }
  if (order.buyerEmail) {
    await enqueueEmail(tx, {
      template: "purchase-not-completed",
      to: order.buyerEmail,
      locale: order.locale,
      refId: attempt.id,
    });
  }
  if (
    i.reason === "LOST_RESERVATION" &&
    ["AWAITING_PAYMENT", "EXPIRED", "PAYMENT_REVIEW"].includes(order.status)
  ) {
    await releaseHoldsOf(tx, order.id);
    await transition(
      tx,
      "order",
      order.id,
      [order.status as "AWAITING_PAYMENT" | "EXPIRED" | "PAYMENT_REVIEW"],
      "CANCELLED",
      {
        statusReason: "LOST_RESERVATION",
        cancelledAt: now,
        fulfillmentBlockedReason: null,
      },
      i.actor,
    );
  }
  await raiseAlert(
    {
      severity: "CRITICAL",
      kind: "PAYMENT_NEEDS_REFUND",
      dedupeKey: `needs-refund:${attempt.id}`,
      entity: "payment_attempt",
      entityId: attempt.id,
      params: {
        reason: i.reason,
        orderNumber: order.number,
        amountMinor: i.amountMinor,
        currency,
      },
    },
    tx,
  );
  return { kind: "needs_refund", reason: i.reason, refundId };
}
