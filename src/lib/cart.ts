/**
 * The cart cookie codec (pure, isomorphic). The cart is a list of artwork ids in the order they were
 * added: `v1.<uuid>.<uuid>…`. It authorizes nothing — every read re-checks each id against the
 * database — so it is not signed; a malformed value simply reads as an empty cart.
 */
export const CART_COOKIE = "gg_cart";
/** Parser bound (and the schema maximum of `checkout.maxCartItems`); keeps the cookie < 1 KB. */
export const CART_COOKIE_MAX_IDS = 20;
/** Thirty days, renewed on every write. */
export const CART_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const VERSION = "v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Unique, lower-case, valid ids in their original order, at most `CART_COOKIE_MAX_IDS`. */
function clean(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (UUID.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= CART_COOKIE_MAX_IDS) break;
  }
  return out;
}

export function parseCartCookie(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const [version, ...ids] = raw.split(".");
  if (version !== VERSION) return [];
  return clean(ids);
}

export function serializeCartCookie(ids: readonly string[]): string {
  return [VERSION, ...clean(ids)].join(".");
}
