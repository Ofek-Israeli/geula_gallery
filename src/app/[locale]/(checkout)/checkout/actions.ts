"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { localePath, paths } from "@/lib/routes";
import { startCheckout } from "@/server/checkout/start";
import { type ActionState, publicAction } from "@/server/next/actions";
import { removeCartIds } from "@/server/next/cart";
import { applyEffects } from "@/server/next/effects";
import {
  type CheckoutActionData,
  cartItemsField,
  checkoutFields,
  refineCheckout,
  startBase,
} from "./_lib/start-input";

/**
 * `startCartCheckoutAction`: every ready work of the cart in one order — one delivery choice, one
 * payment. The same guards as "Buy now" (honeypot, form age, rate limits per IP and email, zod);
 * the server re-quotes and compares the total and each work's price. The ordered works leave the
 * cart; a provider error goes to the order page, where "Pay" retries.
 */
const schema = z
  .object({ ...checkoutFields, item: cartItemsField })
  .superRefine(refineCheckout);

const run = publicAction(
  schema,
  async (input, meta) => {
    const { result, effects } = await startCheckout({
      ...startBase(input, meta),
      items: input.item,
    });
    if (result.kind === "redirect" || result.kind === "provider_error") {
      await removeCartIds(result.artworkIds);
      applyEffects(effects);
      redirect(
        result.kind === "redirect"
          ? result.url
          : `${localePath(meta.locale, paths.order(result.orderNumber, result.accessToken))}&err=provider_error`,
      );
    }
    return { result: result as CheckoutActionData, effects };
  },
  {
    name: "checkout.cart_start",
    limits: [
      { name: "checkoutIp", by: "ip" },
      { name: "checkoutEmail", by: (i) => i.email },
    ],
  },
);

export async function startCartCheckoutAction(
  prev: ActionState<CheckoutActionData>,
  formData: FormData,
): Promise<ActionState<CheckoutActionData>> {
  return run(prev, formData);
}
