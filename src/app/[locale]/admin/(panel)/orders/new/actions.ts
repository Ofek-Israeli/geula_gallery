"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { LOCALE_VALUES } from "@/lib/locale";
import {
  checkboxSchema,
  countrySchema,
  currencySchema,
  emailSchema,
  personNameSchema,
  uuidSchema,
} from "@/lib/validation/common";
import { adminAction } from "@/server/next/actions";
import { createManualOrder } from "@/server/orders/admin";
import {
  domainErrors,
  intSchema,
  nullableText,
  optionalAmountMinorSchema,
} from "../../_shared/action-errors";

/** `/admin/orders/new` (spec §5.10): the manual distance order → `createLinkOrder(kind: 'MANUAL')`. */
export const createManualOrderAction = adminAction(
  z
    .object({
      artworkId: uuidSchema,
      name: personNameSchema,
      email: emailSchema,
      phone: z.string().trim().max(40).default(""),
      country: countrySchema,
      currency: currencySchema,
      price: optionalAmountMinorSchema,
      priceChangeReason: nullableText(500),
      shippingMethod: z.enum([
        "CARRIER_TABLE",
        "QUOTED",
        "LOCAL_PICKUP",
        "ARTIST_DELIVERY",
      ]),
      lockedShipping: optionalAmountMinorSchema,
      buyerLocale: z.enum(LOCALE_VALUES),
      conversationTookPlace: checkboxSchema,
      expiresInHours: intSchema(1, 24 * 14, 48),
    })
    .superRefine((v, ctx) => {
      if (v.shippingMethod === "QUOTED" && v.lockedShipping === null) {
        ctx.addIssue({
          code: "custom",
          path: ["lockedShipping"],
          message: "required",
        });
      }
    }),
  async (i, ctx) => {
    const out = await domainErrors(() =>
      createManualOrder(ctx, {
        artworkId: i.artworkId,
        buyer: { name: i.name, email: i.email, phone: i.phone },
        country: i.country,
        currency: i.currency,
        itemPriceMinor: i.price,
        lockedShippingMinor: i.lockedShipping ?? undefined,
        shippingMethod: i.shippingMethod,
        conversationTookPlace: i.conversationTookPlace,
        expiresInHours: i.expiresInHours,
        locale: i.buyerLocale,
        priceChangeReason: i.priceChangeReason ?? undefined,
      }),
    );
    redirect(`/${ctx.locale}/admin/orders/${out.result.orderId}?created=1`);
  },
  { name: "orders.create_manual", fresh: true },
);
