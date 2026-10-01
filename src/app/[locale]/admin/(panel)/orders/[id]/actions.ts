"use server";

import { z } from "zod";
import { fromJerusalemWallClock, jerusalemDateKey } from "@/lib/format";
import { amountMinorSchema, currencySchema } from "@/lib/validation/common";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { ActionFailure, adminAction } from "@/server/next/actions";
import {
  adminRefund,
  cancelUnpaidOrder,
  confirmRefundFailed,
  markRefundDone,
  recheckPayment,
  recheckRefund,
  recordManualTaxDocument,
  recordPayment,
  resolveUnknownRefund,
  retryFailedRefund,
  retryTaxDocument,
} from "@/server/orders/admin";
import { recordManualTracking } from "@/server/shipping/shipments";
import { domainErrors, nullableText } from "../../_shared/action-errors";

/**
 * Admin order actions (spec §6.10). Every export is wrapped by `adminAction` (session, 2FA,
 * locale, zod) — enforced by the architecture test.
 */
export const recheckPaymentAction = adminAction(
  z.object({ attemptId: z.uuid() }),
  async (input, ctx) => {
    try {
      return await recheckPayment(input.attemptId, ctx);
    } catch (error) {
      if (error instanceof NotFoundError) throw new ActionFailure("NOT_FOUND");
      throw error;
    }
  },
  { name: "orders.recheck" },
);

export const manualTrackingAction = adminAction(
  z.object({
    orderId: z.uuid(),
    carrierName: z.string().trim().min(1).max(80),
    trackingNumber: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9 -]+$/),
    trackingUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
    handedOver: z.literal("on").optional(),
  }),
  async (input, ctx) => {
    try {
      return await recordManualTracking(
        input.orderId,
        {
          carrierName: input.carrierName,
          trackingNumber: input.trackingNumber,
          trackingUrl: input.trackingUrl || null,
          handedOver: input.handedOver === "on",
        },
        ctx,
      );
    } catch (error) {
      if (error instanceof ConflictError) throw new ActionFailure(error.code);
      if (error instanceof NotFoundError) throw new ActionFailure("NOT_FOUND");
      throw error;
    }
  },
  { name: "orders.manual_tracking" },
);

// ---------------------------------------------------------------- WS4: refunds, documents, payments

const refundId = z.object({ refundId: z.uuid() });

export const adminRefundAction = adminAction(
  z.object({
    attemptId: z.uuid(),
    amount: amountMinorSchema,
    note: nullableText(500),
  }),
  async (i, ctx) =>
    domainErrors(() =>
      adminRefund(ctx, {
        attemptId: i.attemptId,
        amountMinor: i.amount,
        note: i.note,
      }),
    ),
  { name: "orders.refund", fresh: true },
);

export const markRefundDoneAction = adminAction(
  refundId.extend({ reference: z.string().trim().min(1).max(200) }),
  async (i, ctx) =>
    domainErrors(() => markRefundDone(ctx, i.refundId, i.reference)),
  { name: "orders.refund_done", fresh: true },
);

export const confirmRefundFailedAction = adminAction(
  refundId,
  async (i, ctx) => domainErrors(() => confirmRefundFailed(ctx, i.refundId)),
  { name: "orders.refund_failed", fresh: true },
);

export const retryRefundAction = adminAction(
  refundId,
  async (i, ctx) => domainErrors(() => retryFailedRefund(ctx, i.refundId)),
  { name: "orders.refund_retry", fresh: true },
);

export const recheckRefundAction = adminAction(
  refundId,
  async (i, ctx) => domainErrors(() => recheckRefund(ctx, i.refundId)),
  { name: "orders.refund_recheck" },
);

export const resolveUnknownRefundAction = adminAction(
  refundId.extend({
    outcome: z.enum(["refunded", "not_refunded"]),
    reference: nullableText(200),
  }),
  async (i, ctx) =>
    domainErrors(() =>
      resolveUnknownRefund(ctx, i.refundId, {
        outcome: i.outcome,
        reference: i.reference,
      }),
    ),
  { name: "orders.refund_resolve", fresh: true },
);

export const retryTaxDocumentAction = adminAction(
  z.object({ taxDocumentId: z.uuid() }),
  async (i, ctx) => domainErrors(() => retryTaxDocument(ctx, i.taxDocumentId)),
  { name: "orders.taxdoc_retry" },
);

export const manualTaxDocumentAction = adminAction(
  z.object({
    taxDocumentId: z.uuid(),
    docNumber: z.string().trim().min(1).max(64),
  }),
  async (i, ctx) =>
    domainErrors(() =>
      recordManualTaxDocument(ctx, i.taxDocumentId, i.docNumber),
    ),
  { name: "orders.taxdoc_manual" },
);

export const recordPaymentAction = adminAction(
  z.object({
    orderId: z.uuid(),
    method: z.enum(["transfer", "cash", "cheque", "bit", "card", "other"]),
    amount: amountMinorSchema,
    currency: currencySchema,
    reference: z.string().trim().max(200).default(""),
    receivedOn: z.iso.date(),
  }),
  async (i, ctx) =>
    domainErrors(() =>
      recordPayment(ctx, i.orderId, {
        method: i.method,
        amountMinor: i.amount,
        currency: i.currency,
        reference: i.reference,
        receivedAt: receivedAt(i.receivedOn),
      }),
    ),
  { name: "orders.record_payment", fresh: true },
);

export const cancelUnpaidOrderAction = adminAction(
  z.object({ orderId: z.uuid() }),
  async (i, ctx) => domainErrors(() => cancelUnpaidOrder(ctx, i.orderId)),
  { name: "orders.cancel_unpaid" },
);

/** Today → now; an earlier day → noon in Jerusalem on that day. */
function receivedAt(day: string): Date {
  if (day === jerusalemDateKey(new Date())) return new Date();
  const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
  return fromJerusalemWallClock({
    year,
    month,
    day: date,
    hour: 12,
    minute: 0,
    second: 0,
  });
}
