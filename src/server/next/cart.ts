import "server-only";
import { cookies } from "next/headers";
import {
  CART_COOKIE,
  CART_COOKIE_MAX_AGE_S,
  parseCartCookie,
  serializeCartCookie,
} from "@/lib/cart";
import { env } from "@/server/env";

/**
 * The cart cookie (the only place that touches it). Strictly necessary and first-party: artwork ids
 * only, HttpOnly, SameSite=Lax, 30 days. Writes happen in Server Actions only (setting a cookie
 * re-renders the page and its layouts, so the header count follows).
 */
export async function readCartIds(): Promise<string[]> {
  const store = await cookies();
  return parseCartCookie(store.get(CART_COOKIE)?.value);
}

export async function writeCartIds(ids: readonly string[]): Promise<void> {
  const store = await cookies();
  if (ids.length === 0) {
    store.delete(CART_COOKIE);
    return;
  }
  store.set(CART_COOKIE, serializeCartCookie(ids), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: CART_COOKIE_MAX_AGE_S,
    secure: env.APP_URL.startsWith("https://"),
  });
}

/** Removes `remove` from the cart (after an order was created for them, or "Buy now"). */
export async function removeCartIds(remove: readonly string[]): Promise<void> {
  if (remove.length === 0) return;
  const ids = await readCartIds();
  const next = ids.filter((id) => !remove.includes(id));
  if (next.length !== ids.length) await writeCartIds(next);
}
