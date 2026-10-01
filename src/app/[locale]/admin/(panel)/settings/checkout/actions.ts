"use server";

import { z } from "zod";
import { checkboxSchema } from "@/lib/validation/common";
import { saveCheckoutSettings } from "@/server/admin/settings";
import { adminAction } from "@/server/next/actions";
import { domainErrors } from "../../_shared/action-errors";

/** `/admin/settings/checkout` (spec §4.7 `checkout`): validated again by the settings schema. */
const int = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);
const rate = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().replace(",", ".") : v),
  z.coerce.number().positive().max(1000),
);

export const saveCheckoutAction = adminAction(
  z.object({
    reservationMinutes: int(10, 240),
    linkHoursDefault: int(1, 24 * 14),
    maxActiveHoldsPerEmail: int(1, 20),
    maxActiveHoldsPerIp: int(1, 50),
    maxHoldsPerArtworkPerBuyer24h: int(1, 20),
    holdCooldownMinutes: int(0, 1440),
    maxHoldCountPerOrder: int(1, 20),
    maxWebHoldSpanMinutes: int(10, 1440),
    maxAttemptsPerOrder: int(1, 5),
    maxInstallments: int(1, 36),
    paypalForIsraeliDestinations: checkboxSchema,
    receiptForRefundedPayments: checkboxSchema,
    conversationLookbackDays: int(0, 3650),
    ilsPerUsd: rate,
    ilsPerEur: rate,
    ilsPerGbp: rate,
    fxAsOf: z.iso.date(),
  }),
  async ({ ilsPerUsd, ilsPerEur, ilsPerGbp, fxAsOf, ...rest }, ctx) =>
    domainErrors(() =>
      saveCheckoutSettings(ctx, {
        ...rest,
        fx: { ilsPerUsd, ilsPerEur, ilsPerGbp, asOf: fxAsOf },
      }),
    ),
  { name: "settings.checkout", fresh: true },
);
