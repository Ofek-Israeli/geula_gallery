"use server";

import { z } from "zod";
import {
  amountMinorSchema,
  countrySchema,
  currencySchema,
  emailSchema,
  personNameSchema,
  uuidSchema,
} from "@/lib/validation/common";
import { adminAction } from "@/server/next/actions";
import {
  closeRequest,
  declineRequest,
  replyToRequest,
  sendQuote,
} from "@/server/requests/service";
import {
  domainErrors,
  intSchema,
  nullableText,
  optionalAmountMinorSchema,
} from "../_shared/action-errors";

/** Inbox actions (spec §5.8, §6.10 `/admin/inbox`). Every export is wrapped by `adminAction`. */
const id = z.object({ requestId: uuidSchema });

export const replyAction = adminAction(
  id.extend({ reply: z.string().trim().min(1).max(5000) }),
  async (i, ctx) =>
    domainErrors(() => replyToRequest(ctx, i.requestId, i.reply)),
  { name: "inbox.reply" },
);

export const declineAction = adminAction(
  id.extend({ reply: nullableText(5000) }),
  async (i, ctx) =>
    domainErrors(() => declineRequest(ctx, i.requestId, i.reply)),
  { name: "inbox.decline" },
);

export const closeAction = adminAction(
  id,
  async (i, ctx) => domainErrors(() => closeRequest(ctx, i.requestId)),
  { name: "inbox.close" },
);

export const sendQuoteAction = adminAction(
  id
    .extend({
      name: personNameSchema,
      email: emailSchema,
      phone: z.string().trim().max(40).default(""),
      country: countrySchema,
      currency: currencySchema,
      itemPrice: amountMinorSchema,
      shippingMethod: z.enum([
        "CARRIER_TABLE",
        "QUOTED",
        "LOCAL_PICKUP",
        "ARTIST_DELIVERY",
      ]),
      lockedShipping: optionalAmountMinorSchema,
      expiresInHours: intSchema(1, 24 * 14, 48),
      priceChangeReason: nullableText(500),
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
  async (i, ctx) =>
    domainErrors(() =>
      sendQuote(ctx, i.requestId, {
        buyer: { name: i.name, email: i.email, phone: i.phone },
        country: i.country,
        currency: i.currency,
        itemPriceMinor: i.itemPrice,
        shippingMethod: i.shippingMethod,
        lockedShippingMinor: i.lockedShipping ?? undefined,
        expiresInHours: i.expiresInHours,
        priceChangeReason: i.priceChangeReason ?? undefined,
      }),
    ),
  { name: "inbox.send_quote", fresh: true },
);
