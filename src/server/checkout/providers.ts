import "server-only";
import { and, eq } from "drizzle-orm";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { type Order, paymentAttempts } from "@/server/db/schema";
import { env as defaultEnv, type Env } from "@/server/env";
import { checkoutProviders } from "@/server/payments/registry";
import type { PaymentProvider } from "@/server/payments/types";
import { getSetting } from "@/server/settings";
import { liveProvidersBlocked } from "./quote";

/**
 * The payment methods an existing order may pay with: the order page's "Pay now" choices and the
 * only ones `startPaymentForOrder` accepts. The checkout's providers for the order's currency and
 * destination (live ones refused while go-live blockers exist or in the preview), and no live
 * provider for an order that already has a TEST attempt: a test order never becomes a real payment.
 */
export async function orderPaymentProviders(
  order: Pick<Order, "id" | "currency" | "shipCountry" | "isDemo">,
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<PaymentProvider[]> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const checkout = await getSetting("checkout", db);
  const offered = checkoutProviders(
    {
      currency: order.currency,
      destinationCountry: order.shipCountry,
      isDemo: order.isDemo,
      paypalForIsraeliDestinations: checkout.paypalForIsraeliDestinations,
      liveBlocked: await liveProvidersBlocked(db, e),
    },
    { env: e },
  );
  const [test] = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, order.id),
        eq(paymentAttempts.providerMode, "TEST"),
      ),
    )
    .limit(1);
  return test ? offered.filter((p) => p.mode !== "LIVE") : offered;
}
