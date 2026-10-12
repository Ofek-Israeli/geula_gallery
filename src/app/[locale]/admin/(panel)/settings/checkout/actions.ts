"use server";

import { z } from "zod";
import { checkboxSchema } from "@/lib/validation/common";
import {
  saveCheckoutSettings,
  saveSaleSettings,
} from "@/server/admin/settings";
import { ActionFailure, adminAction } from "@/server/next/actions";
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
    maxCartItems: int(1, 20),
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

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.iso.date().nullable(),
);

/** The sale box (`src/lib/sale.ts`): only `checkout.sale` changes. */
export const saveSaleAction = adminAction(
  z.object({
    saleEnabled: checkboxSchema,
    salePercentOff: int(1, 90),
    saleStartsOn: optionalDate,
    saleEndsOn: optionalDate,
    saleLabelHe: z.string().trim().min(1).max(120),
    saleLabelEn: z.string().trim().min(1).max(120),
  }),
  async (i, ctx) => {
    if (i.saleStartsOn && i.saleEndsOn && i.saleEndsOn < i.saleStartsOn) {
      throw new ActionFailure("DATES");
    }
    return domainErrors(() =>
      saveSaleSettings(ctx, {
        enabled: i.saleEnabled,
        percentOff: i.salePercentOff,
        startsOn: i.saleStartsOn,
        endsOn: i.saleEndsOn,
        label: { he: i.saleLabelHe, en: i.saleLabelEn },
      }),
    );
  },
  { name: "settings.sale", fresh: true },
);
