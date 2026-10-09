"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { localePath, paths } from "@/lib/routes";
import { slugSchema } from "@/lib/validation/common";
import { startCheckout } from "@/server/checkout/start";
import { type ActionState, publicAction } from "@/server/next/actions";
import { removeCartIds } from "@/server/next/cart";
import { applyEffects } from "@/server/next/effects";
import {
  type CheckoutActionData,
  checkoutFields,
  refineCheckout,
  startBase,
} from "../_lib/start-input";

/**
 * `startCheckoutAction` ("Buy now", spec §5.1 step 3): honeypot → form age → rate limits (10 / 10 min
 * per IP, 5 / h per email) → zod with locale-aware messages → `startCheckout` → redirect to the
 * provider. A work bought this way also leaves the cart. A provider error goes to the order page
 * (the hold is kept there and "Pay" retries).
 */
const schema = z
  .object({ ...checkoutFields, slug: slugSchema })
  .superRefine(refineCheckout);

const run = publicAction(
  schema,
  async (input, meta) => {
    const { result, effects } = await startCheckout({
      ...startBase(input, meta),
      slug: input.slug,
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
    name: "checkout.start",
    limits: [
      { name: "checkoutIp", by: "ip" },
      { name: "checkoutEmail", by: (i) => i.email },
    ],
  },
);

export async function startCheckoutAction(
  prev: ActionState<CheckoutActionData>,
  formData: FormData,
): Promise<ActionState<CheckoutActionData>> {
  return run(prev, formData);
}
