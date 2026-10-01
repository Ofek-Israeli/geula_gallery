import "server-only";
import { eq } from "drizzle-orm";
import type { Currency } from "@/lib/money";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworks } from "@/server/db/schema";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  buildProvider,
  checkoutProviders,
  isProviderConfigured,
} from "@/server/payments/registry";
import { PROVIDER_IDS } from "@/server/payments/types";
import { getSetting } from "@/server/settings";
import { carrierFor } from "@/server/shipping/registry";
import type { ShippingMethod } from "@/server/shipping/types";
import { itemPriceMinor, orderAmounts, shippingOptions } from "./pricing";
import { ordersWithAttemptInFlight } from "./reservations";
import type { CheckoutQuote, CheckoutQuoteRequest } from "./types";

/**
 * `getCheckoutQuote()` (spec §5.1 step 2; frozen contract). Read-only and lock-free: it prices the
 * page, and `startCheckout` re-runs it before anything is written (a different total →
 * `price_changed`). Everything the buyer sees is server-computed; the client never sends prices.
 *
 * Order of checks: work exists and is AVAILABLE → no live foreign hold → priced (not price on
 * request, not quote-only) → currency (IL ⇒ ILS; USD only abroad with a USD price) → providers
 * (demo item with a live provider configured is refused) → shipping methods for the destination
 * (the requested method if it is ok, else the first ok one; none ok → the carrier's block reason).
 */
export interface QuoteDeps {
  db?: DbOrTx;
  env?: Env;
  now?: Date;
}

/** Go-live blockers (WS6 `golive.ts`); until then: the business profile is not completed. */
export async function liveProvidersBlocked(db: DbOrTx): Promise<boolean> {
  const profile = await getSetting("business_profile", db);
  return !profile.completed;
}

export async function getCheckoutQuote(
  req: CheckoutQuoteRequest,
  deps: QuoteDeps = {},
): Promise<CheckoutQuote> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const now = deps.now ?? new Date();

  const [a] = await db
    .select()
    .from(artworks)
    .where(eq(artworks.slug, req.slug))
    .limit(1);
  if (!a?.isPublished) {
    return { kind: "blocked", reason: "NOT_AVAILABLE", artworkId: null };
  }
  const blocked = (
    reason: Extract<CheckoutQuote, { kind: "blocked" }>["reason"],
  ) => ({ kind: "blocked", reason, artworkId: a.id }) as const;

  if (a.saleStatus !== "AVAILABLE") return blocked("NOT_AVAILABLE");
  if (a.reservedByOrderId !== null && a.reservedUntil !== null) {
    const live = a.reservedUntil.getTime() > now.getTime();
    const inFlight =
      !live &&
      (await ordersWithAttemptInFlight(db, [a.reservedByOrderId])).size > 0;
    if (live || inFlight) return blocked("RESERVED");
  }
  if (a.priceOnRequest || a.priceIlsMinor === null)
    return blocked("NOT_PRICED");
  if (a.quoteOnly) return blocked("QUOTE_ONLY");

  const country = (req.country ?? "IL").toUpperCase();
  const usdAvailable = country !== "IL" && a.priceUsdMinor !== null;
  const currency: Currency =
    req.currency === "USD" && usdAvailable ? "USD" : "ILS";
  const price = itemPriceMinor(a, currency);
  if (price === null) return blocked("NOT_PRICED");

  // Sequential reads: `db` may be a single dedicated connection (race tests).
  const checkout = await getSetting("checkout", db);
  const shipping = await getSetting("shipping", db);
  const profile = await getSetting("business_profile", db);
  const liveBlocked = !profile.completed;

  // A demo item is never offered while a live provider is configured (spec §5.1 step 1).
  if (a.isDemo) {
    const liveConfigured = PROVIDER_IDS.some(
      (id) =>
        e.PAYMENT_PROVIDERS.includes(id) &&
        isProviderConfigured(id, e) &&
        buildProvider(id, { env: e })?.mode === "LIVE",
    );
    if (liveConfigured) return blocked("DEMO_LIVE_PROVIDER");
  }
  const providers = checkoutProviders(
    {
      currency,
      destinationCountry: country,
      isDemo: a.isDemo,
      paypalForIsraeliDestinations: checkout.paypalForIsraeliDestinations,
      liveBlocked,
    },
    { env: e },
  );
  if (providers.length === 0) return blocked("NO_PROVIDER");

  const options = shippingOptions({
    items: [a],
    country,
    currency,
    date: now,
    shipping,
    checkout,
    carrier: carrierFor(country, { env: e }),
  });
  const wanted: ShippingMethod | undefined = req.method;
  const selected =
    options.ok.find((q) => q.method === wanted) ?? options.ok[0] ?? null;
  if (!selected) {
    const carrierQuote = options.all[0];
    return blocked(carrierQuote?.reason ?? "ZONE_DISABLED");
  }
  const amounts = orderAmounts({
    itemsTotalMinor: price,
    quote: selected,
    vatMode: profile.vatMode,
    country,
    date: now,
  });
  return {
    kind: "ok",
    artworkId: a.id,
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
  };
}
