"use server";

import { z } from "zod";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { ActionFailure, adminAction } from "@/server/next/actions";
import { recheckPayment } from "@/server/orders/admin";
import { recordManualTracking } from "@/server/shipping/shipments";

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
