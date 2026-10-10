import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { Currency } from "@/lib/money";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworks } from "@/server/db/schema";
import { env as defaultEnv, type Env } from "@/server/env";
import { liveBlocked } from "@/server/golive";
import {
  buildProvider,
  checkoutProviders,
  isProviderConfigured,
} from "@/server/payments/registry";
import { PROVIDER_IDS } from "@/server/payments/types";
import { getSetting } from "@/server/settings";
import { carrierFor } from "@/server/shipping/registry";
import type { ShippingMethod } from "@/server/shipping/types";
import {
  anyRollable,
  itemPriceMinor,
  orderAmounts,
  shippingOptions,
} from "./pricing";
import { ordersWithAttemptInFlight } from "./reservations";
import type {
  CheckoutQuote,
  CheckoutQuoteItem,
  CheckoutQuoteRequest,
  ItemProblem,
  ItemProblemReason,
  QuoteBlockReason,
} from "./types";

/**
 * `getCheckoutQuote()` (spec §5.1 step 2). Read-only and lock-free: it prices the page, and
 * `startCheckout` re-runs it before anything is written (a different total or item price →
 * `price_changed`). Everything the buyer sees is server-computed; the client never sends prices.
 * It quotes one work (`slug`) or a cart (`artworkIds`) through the same N-item core.
 *
 * Order of checks: work exists → online sales are open (`SALES_OPEN`) → work is AVAILABLE → no live foreign hold → priced (not price on
 * request, not quote-only) → currency (IL ⇒ ILS; USD only abroad with a USD price) → providers
 * (demo item with a live provider configured is refused) → shipping methods for the destination
 * (the requested method if it is ok, else the first ok one; none ok → the carrier's block reason).
 */
export interface QuoteDeps {
  db?: DbOrTx;
  env?: Env;
  now?: Date;
}

/**
 * `liveBlocked` for `checkoutProviders` (spec §5.1 step 3.4): WS6's go-live blockers
 * (`golive.ts#liveBlocked`). They only matter when a configured provider is LIVE, so the blocker
 * queries run only then.
 */
export async function liveProvidersBlocked(
  db: DbOrTx,
  e: Env = defaultEnv,
): Promise<boolean> {
  const anyLive = e.PAYMENT_PROVIDERS.some(
    (id) => buildProvider(id, { env: e })?.mode === "LIVE",
  );
  if (!anyLive) return false;
  return liveBlocked({ db, env: e });
}

type ArtworkRow = typeof artworks.$inferSelect;
type Blocked = Extract<CheckoutQuote, { kind: "blocked" }>;

function blocked(
  reason: QuoteBlockReason,
  problems: ItemProblem[] = [],
  artworkId: string | null = problems[0]?.artworkId ?? null,
): Blocked {
  return { kind: "blocked", reason, artworkId, problems };
}

/** Shipping block reasons that one work alone can cause (the cart names it). */
const ITEM_SHIPPING_REASONS = new Set<ItemProblemReason>([
  "NOT_INTERNATIONAL",
  "SIZE_QUOTE",
  "QUOTE_ONLY",
  "VALUE_CAP",
]);

export async function getCheckoutQuote(
  req: CheckoutQuoteRequest,
  deps: QuoteDeps = {},
): Promise<CheckoutQuote> {
  const db = deps.db ?? defaultDb;
  if (req.slug !== undefined) {
    const [a] = await db
      .select()
      .from(artworks)
      .where(eq(artworks.slug, req.slug))
      .limit(1);
    if (!a?.isPublished) return blocked("NOT_AVAILABLE", [], null);
    return quoteArtworks([a], req, deps);
  }
  const ids = [...new Set(req.artworkIds)];
  if (ids.length === 0) return blocked("NOT_AVAILABLE", [], null);
  const rows = await db
    .select()
    .from(artworks)
    .where(inArray(artworks.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.get(id)?.isPublished);
  if (missing.length > 0) {
    return blocked(
      "NOT_AVAILABLE",
      missing.map((artworkId) => ({ artworkId, reason: "NOT_AVAILABLE" })),
    );
  }
  return quoteArtworks(
    ids.map((id) => byId.get(id) as ArtworkRow),
    req,
    deps,
  );
}

/**
 * The N-item core (one work for "Buy now", the cart's works otherwise). Every work is checked and
 * every culprit is reported; a single work behaves exactly like the original single-item quote.
 */
async function quoteArtworks(
  items: ArtworkRow[],
  req: CheckoutQuoteRequest,
  deps: QuoteDeps,
): Promise<CheckoutQuote> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const now = deps.now ?? new Date();
  // A showcase site sells nothing online; the page keeps the work (and its "Ask").
  if (!e.SALES_OPEN) return blocked("SALES_CLOSED", [], items[0]?.id ?? null);

  // Sequential reads: `db` may be a single dedicated connection (race tests).
  const checkout = await getSetting("checkout", db);
  if (items.length > checkout.maxCartItems) return blocked("TOO_MANY_ITEMS");

  // Per-work availability, in the original order of checks; the first culprit's reason wins.
  const expiredHolders = items
    .filter(
      (a) =>
        a.reservedByOrderId !== null &&
        a.reservedUntil !== null &&
        a.reservedUntil.getTime() <= now.getTime(),
    )
    .map((a) => a.reservedByOrderId);
  const inFlight = await ordersWithAttemptInFlight(db, expiredHolders);
  const problems: ItemProblem[] = [];
  for (const a of items) {
    const reason = itemProblem(a, now, inFlight);
    if (reason) problems.push({ artworkId: a.id, reason });
  }
  if (problems.length > 0) {
    return blocked(
      (problems[0] as ItemProblem).reason as QuoteBlockReason,
      problems,
    );
  }

  // Demo and real works are never one order (orders.is_demo decides the providers).
  const isDemo = (items[0] as ArtworkRow).isDemo;
  if (items.some((a) => a.isDemo !== isDemo)) {
    return blocked(
      "MIXED_DEMO",
      items
        .filter((a) => a.isDemo)
        .map((a) => ({ artworkId: a.id, reason: "MIXED_DEMO" })),
    );
  }

  const country = (req.country ?? "IL").toUpperCase();
  const usdAvailable =
    country !== "IL" && items.every((a) => a.priceUsdMinor !== null);
  const currency: Currency =
    req.currency === "USD" && usdAvailable ? "USD" : "ILS";
  const quoted: CheckoutQuoteItem[] = [];
  for (const a of items) {
    const price = itemPriceMinor(a, currency);
    if (price === null) {
      return blocked("NOT_PRICED", [{ artworkId: a.id, reason: "NOT_PRICED" }]);
    }
    quoted.push({ artworkId: a.id, slug: a.slug, priceMinor: price });
  }
  const itemsTotalMinor = quoted.reduce((sum, i) => sum + i.priceMinor, 0);

  const shipping = await getSetting("shipping", db);
  const profile = await getSetting("business_profile", db);

  // A demo item is never offered while a live provider is configured (spec §5.1 step 1).
  if (isDemo) {
    const liveConfigured = PROVIDER_IDS.some(
      (id) =>
        e.PAYMENT_PROVIDERS.includes(id) &&
        isProviderConfigured(id, e) &&
        buildProvider(id, { env: e })?.mode === "LIVE",
    );
    if (liveConfigured)
      return blocked("DEMO_LIVE_PROVIDER", [], (items[0] as ArtworkRow).id);
  }
  const providers = checkoutProviders(
    {
      currency,
      destinationCountry: country,
      isDemo,
      paypalForIsraeliDestinations: checkout.paypalForIsraeliDestinations,
      liveBlocked: await liveProvidersBlocked(db, e),
    },
    { env: e },
  );
  if (providers.length === 0)
    return blocked("NO_PROVIDER", [], (items[0] as ArtworkRow).id);

  const carrier = carrierFor(country, { env: e });
  const rollable = anyRollable(items);
  const packing = rollable && req.packing === "ROLLED" ? "ROLLED" : "STRETCHED";
  const optionsFor = (works: ArtworkRow[]) =>
    shippingOptions({
      items: works,
      country,
      currency,
      date: now,
      shipping,
      checkout,
      carrier,
      packing,
    });
  const options = optionsFor(items);
  const wanted: ShippingMethod | undefined = req.method;
  const selected =
    options.ok.find((q) => q.method === wanted) ?? options.ok[0] ?? null;
  if (!selected) {
    const reason = options.all[0]?.reason ?? "ZONE_DISABLED";
    // Name the works that cannot ship on their own; [] when only the combination is the problem
    // (e.g. the carrier's value cap on the cart total) or the destination itself is refused.
    const culprits: ItemProblem[] = [];
    if (
      items.length > 1 &&
      ITEM_SHIPPING_REASONS.has(reason as ItemProblemReason)
    ) {
      for (const a of items) {
        const alone = optionsFor([a]);
        if (alone.ok.length === 0) {
          const r = alone.all[0]?.reason;
          if (r && ITEM_SHIPPING_REASONS.has(r as ItemProblemReason)) {
            culprits.push({ artworkId: a.id, reason: r as ItemProblemReason });
          }
        }
      }
    }
    return blocked(
      reason,
      culprits,
      items.length === 1
        ? (items[0] as ArtworkRow).id
        : (culprits[0]?.artworkId ?? null),
    );
  }
  const amounts = orderAmounts({
    itemsTotalMinor,
    quote: selected,
    vatMode: profile.vatMode,
    country,
    date: now,
  });
  return {
    kind: "ok",
    artworkId: (items[0] as ArtworkRow).id,
    items: quoted,
    country,
    currency,
    itemsTotalMinor: amounts.itemsTotalMinor,
    shipping: selected,
    methods: options.ok,
    totalMinor: amounts.totalMinor,
    vatMinor: amounts.vatMinor,
    vatRateBp: amounts.vatRateBp,
    providers: providers.map((p) => ({
      id: p.id,
      label: p.id,
      wallets: p.capabilities.wallets,
      installments: p.capabilities.installments,
    })),
    notices: selected.notices,
    usdAvailable,
    rollable,
    packing,
  };
}

/** Why one work cannot be checked out now (the original single-item order of checks), or null. */
function itemProblem(
  a: ArtworkRow,
  now: Date,
  inFlight: Set<string>,
): ItemProblemReason | null {
  if (a.saleStatus !== "AVAILABLE") return "NOT_AVAILABLE";
  if (a.reservedByOrderId !== null && a.reservedUntil !== null) {
    const live = a.reservedUntil.getTime() > now.getTime();
    if (live || inFlight.has(a.reservedByOrderId)) return "RESERVED";
  }
  if (a.priceOnRequest || a.priceIlsMinor === null) return "NOT_PRICED";
  if (a.quoteOnly) return "QUOTE_ONLY";
  return null;
}
