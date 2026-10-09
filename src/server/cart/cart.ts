import "server-only";
import type { Locale } from "@/lib/locale";
import {
  type CartWorkDTO,
  countCartWorks,
  getCartWorks,
} from "@/server/catalog/queries";
import { orderArtworkIds } from "@/server/checkout/reservations";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { getSetting } from "@/server/settings";

/**
 * The cart (works the buyer collected before one checkout). Nothing is reserved while a work sits in
 * the cart: the 35-minute hold is taken only by "Continue to payment" (spec §3.5), all works
 * together. The cart is a list of ids (cookie); every read re-checks each work's live state.
 *
 * - kept: published and not sold (sold works show once as "no longer available", then drop);
 * - ready: available and buyable now, and not mixing demo with real works — only ready works go to
 *   the checkout.
 */
export type CartReadiness =
  | "ready"
  | "reserved"
  | "on_hold"
  | "not_for_sale"
  | "not_buyable"
  | "sold"
  | "mixed";

export interface CartLine {
  work: CartWorkDTO;
  readiness: CartReadiness;
}

export interface CartView {
  lines: CartLine[];
  /** Ids worth keeping (the next cart write prunes the others). */
  keptIds: string[];
  /** Ids of the ready works, in cart order. */
  readyIds: string[];
  maxItems: number;
}

function baseReadiness(w: CartWorkDTO): Exclude<CartReadiness, "mixed"> {
  switch (w.state.kind) {
    case "available":
      return w.state.buyable ? "ready" : "not_buyable";
    case "reserved":
      return "reserved";
    case "on_hold":
      return "on_hold";
    case "not_for_sale":
      return "not_for_sale";
    case "sold":
      return "sold";
  }
}

export async function loadCart(
  locale: Locale,
  ids: readonly string[],
  db: DbOrTx = defaultDb,
): Promise<CartView> {
  const checkout = await getSetting("checkout", db);
  const works = await getCartWorks(locale, ids, db);
  const lines: CartLine[] = works.map((work) => ({
    work,
    readiness: baseReadiness(work),
  }));
  // Demo and real works are never one order: when both are ready, the demo ones step aside.
  const ready = lines.filter((l) => l.readiness === "ready");
  if (ready.some((l) => l.work.isDemo) && ready.some((l) => !l.work.isDemo)) {
    for (const l of ready) if (l.work.isDemo) l.readiness = "mixed";
  }
  return {
    lines,
    keptIds: lines.filter((l) => l.readiness !== "sold").map((l) => l.work.id),
    readyIds: lines
      .filter((l) => l.readiness === "ready")
      .map((l) => l.work.id),
    maxItems: checkout.maxCartItems,
  };
}

export type AddOutcome = "added" | "already" | "full" | "mixed" | "unavailable";

/** Adds one work (must be buyable now). Returns the ids to store and what happened. */
export async function addToCart(
  ids: readonly string[],
  artworkId: string,
  db: DbOrTx = defaultDb,
): Promise<{ ids: string[]; outcome: AddOutcome }> {
  const id = artworkId.toLowerCase();
  const cart = await loadCart("en", [...ids, id], db);
  const kept = cart.keptIds.filter((x) => x !== id);
  const target = cart.lines.find((l) => l.work.id === id);
  if (ids.includes(id) && target && target.readiness !== "sold") {
    return { ids: cart.keptIds, outcome: "already" };
  }
  const buyable =
    target?.work.state.kind === "available" && target.work.state.buyable;
  if (!target || !buyable) return { ids: kept, outcome: "unavailable" };
  if (kept.length >= cart.maxItems) return { ids: kept, outcome: "full" };
  const others = cart.lines.filter(
    (l) => l.work.id !== id && l.readiness !== "sold",
  );
  if (others.some((l) => l.work.isDemo !== target.work.isDemo)) {
    return { ids: kept, outcome: "mixed" };
  }
  return { ids: [...kept, id], outcome: "added" };
}

/** Several works at once (restoring an expired order's works); unavailable ones are skipped. */
export async function addManyToCart(
  ids: readonly string[],
  artworkIds: readonly string[],
  db: DbOrTx = defaultDb,
): Promise<string[]> {
  let next = [...ids];
  for (const id of artworkIds) {
    next = (await addToCart(next, id, db)).ids;
  }
  return next;
}

/** Puts an (expired) order's works back in the cart. */
export async function addOrderWorksToCart(
  ids: readonly string[],
  orderId: string,
  db: DbOrTx = defaultDb,
): Promise<string[]> {
  return addManyToCart(ids, await orderArtworkIds(db, orderId), db);
}

/** Removes one work, pruning ids that are no longer worth keeping. */
export async function removeFromCart(
  ids: readonly string[],
  artworkId: string,
  db: DbOrTx = defaultDb,
): Promise<string[]> {
  const id = artworkId.toLowerCase();
  const cart = await loadCart("en", ids, db);
  return cart.keptIds.filter((x) => x !== id);
}

/** The header count: works in the cart that are published and not sold. */
export function cartCount(
  ids: readonly string[],
  db: DbOrTx = defaultDb,
): Promise<number> {
  return countCartWorks(ids, db);
}
