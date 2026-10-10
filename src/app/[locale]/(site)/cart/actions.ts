"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import type { Locale } from "@/lib/locale";
import {
  CHECKOUT_QUERY_KEYS,
  type CheckoutQuery,
  localePath,
  paths,
} from "@/lib/routes";
import { slugSchema } from "@/lib/validation/common";
import {
  addOrderWorksToCart,
  addToCart,
  removeFromCart,
} from "@/server/cart/cart";
import { orderIdForToken } from "@/server/checkout/order-view";
import { ActionFailure, publicAction } from "@/server/next/actions";
import { readCartIds, writeCartIds } from "@/server/next/cart";

/**
 * Cart actions: add a work (from its page), remove a work (cart page or cart checkout), and put an
 * expired order's works back in the cart (order page). Plain POST forms that work without
 * JavaScript; each ends in a redirect with a `cart=` notice. Nothing is reserved here.
 */
const localeOf = (formData: FormData): Locale =>
  formData.get("locale") === "en" ? "en" : "he";

const runAdd = publicAction(
  z.object({ artworkId: z.uuid(), slug: slugSchema }),
  async (input, meta) => {
    const { ids, outcome } = await addToCart(
      await readCartIds(),
      input.artworkId,
    );
    await writeCartIds(ids);
    redirect(
      `${localePath(meta.locale, paths.artwork(input.slug))}?cart=${outcome}#buy-box`,
    );
  },
  { name: "cart.add", honeypot: false, minFormAge: false },
);

export async function addToCartAction(formData: FormData): Promise<void> {
  await runAdd(null, formData);
  redirect(localePath(localeOf(formData), paths.works()));
}

/**
 * Removing from the cart checkout returns to the same checkout URL: only the checkout keys of
 * `query` are kept. 2000 characters fit a 120-character Hebrew city once percent-encoded.
 */
const runRemove = publicAction(
  z.object({
    artworkId: z.uuid(),
    returnTo: z.enum(["cart", "checkout"]).default("cart"),
    query: z.string().max(2000).optional(),
  }),
  async (input, meta) => {
    await writeCartIds(
      await removeFromCart(await readCartIds(), input.artworkId),
    );
    if (input.returnTo === "checkout") {
      const q = new URLSearchParams(input.query ?? "");
      const query: CheckoutQuery = Object.fromEntries(
        CHECKOUT_QUERY_KEYS.flatMap((k) => {
          const v = q.get(k);
          return v ? [[k, v]] : [];
        }),
      );
      redirect(localePath(meta.locale, paths.cartCheckout(query)));
    }
    redirect(localePath(meta.locale, paths.cart({ cart: "removed" })));
  },
  { name: "cart.remove", honeypot: false, minFormAge: false },
);

export async function removeFromCartAction(formData: FormData): Promise<void> {
  await runRemove(null, formData);
  redirect(localePath(localeOf(formData), paths.cart()));
}

const runRestore = publicAction(
  z.object({
    number: z.string().regex(/^GG-[0-9A-Z]{6}$/),
    k: z.string().min(1).max(64),
  }),
  async (input, meta) => {
    const order = await orderIdForToken(input.number, input.k);
    if (!order) throw new ActionFailure("NOT_FOUND");
    const ids = await addOrderWorksToCart(await readCartIds(), order.id);
    await writeCartIds(ids);
    redirect(localePath(meta.locale, paths.cart({ cart: "restored" })));
  },
  {
    name: "cart.restore",
    honeypot: false,
    minFormAge: false,
    limits: [{ name: "checkoutIp", by: "ip" }],
  },
);

export async function addOrderToCartAction(formData: FormData): Promise<void> {
  await runRestore(null, formData);
  redirect(localePath(localeOf(formData), paths.cart()));
}
