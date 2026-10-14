import "server-only";
import { asc, eq } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import { getCartWorks } from "@/server/catalog/queries";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  orderItems,
  orders,
  paymentAttempts,
} from "@/server/db/schema";
import { env as defaultEnv, type Env } from "@/server/env";
import { isPendingSaleRef } from "@/server/payments/providers/isracard-map";
import { providerForAttempt } from "@/server/payments/registry";
import { isHostedFieldsProvider } from "@/server/payments/types";
import { getSetting } from "@/server/settings";
import { orderUrlFor } from "./start";

/**
 * The pay page of one Isracard attempt (`/checkout/pay/[attemptId]?t=`; the caller checks `t`):
 * - `ready`: the attempt is PENDING with its `hf:` placeholder and the order's hold is live;
 * - `expired`: the order can no longer be paid here (the hold lapsed or the order ended);
 * - `done`: the attempt was already submitted: the order page says where it stands.
 * Buyer details prefill the form only in live mode (spec §4.2: no PII to a test environment).
 */
export interface PayPageView {
  attemptId: string;
  state: "ready" | "expired" | "done";
  orderNumber: string;
  /** Absolute order page URL (with its access token). */
  orderUrl: string;
  currency: Currency;
  items: {
    id: string;
    title: string;
    priceMinor: number;
    /** The list price while a sale ran at checkout (struck through); null otherwise. */
    wasMinor: number | null;
    image: { src: string; alt: string; width: number; height: number } | null;
    dimensions: {
      heightMm: number;
      widthMm: number;
      depthMm: number | null;
    } | null;
  }[];
  itemsTotalMinor: number;
  shippingMinor: number;
  insuranceMinor: number;
  totalMinor: number;
  vatMinor: number;
  international: boolean;
  /** ISO: when the hold ends. */
  holdUntil: string | null;
  maxInstallments: number;
  prefill: { name: string; email: string; phone: string } | null;
  /** What the page passes to the hosted fields' script; null when the provider is not set up. */
  client: { apiKey: string; testMode: boolean; scriptUrl: string } | null;
}

interface Snapshot {
  heightMm?: number;
  widthMm?: number;
  depthMm?: number | null;
  sale?: { listPriceMinor?: number | null };
}

export async function getPayPageView(
  attemptId: string,
  locale: Locale,
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<PayPageView | null> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const [row] = await db
    .select({ attempt: paymentAttempts, order: orders })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(eq(paymentAttempts.id, attemptId));
  if (row?.attempt.provider !== "ISRACARD") return null;
  const { attempt, order } = row;
  const items = await db
    .select({
      id: orderItems.id,
      artworkId: orderItems.artworkId,
      titleHe: orderItems.titleHe,
      titleEn: orderItems.titleEn,
      priceMinor: orderItems.priceMinor,
      snapshot: orderItems.snapshot,
      reservedBy: artworks.reservedByOrderId,
      reservedUntil: artworks.reservedUntil,
    })
    .from(orderItems)
    .innerJoin(artworks, eq(artworks.id, orderItems.artworkId))
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  const now = Date.now();
  const holdLive =
    order.status === "AWAITING_PAYMENT" &&
    order.expiresAt !== null &&
    order.expiresAt.getTime() > now &&
    items.length > 0 &&
    items.every(
      (i) =>
        i.reservedBy === order.id &&
        i.reservedUntil !== null &&
        i.reservedUntil.getTime() > now,
    );
  const submitted =
    attempt.status !== "PENDING" || !isPendingSaleRef(attempt.providerRef);
  const state = submitted ? "done" : holdLive ? "ready" : "expired";

  const works = new Map(
    (
      await getCartWorks(
        locale,
        items.map((i) => i.artworkId),
        db,
      )
    ).map((w) => [w.id, w]),
  );
  const checkout = await getSetting("checkout", db);
  const pfa =
    state === "ready"
      ? await providerForAttempt(attempt, { env: e, db })
      : null;
  const provider =
    pfa?.kind === "ok" && isHostedFieldsProvider(pfa.provider)
      ? pfa.provider
      : null;
  const holdUntil = holdLive
    ? new Date(
        Math.min(
          order.expiresAt?.getTime() ?? now,
          ...items.map((i) => i.reservedUntil?.getTime() ?? now),
        ),
      ).toISOString()
    : null;

  return {
    attemptId,
    state,
    orderNumber: order.number,
    orderUrl: orderUrlFor(order, locale, {}, e),
    currency: order.currency,
    items: items.map((i) => {
      const snap = (i.snapshot ?? {}) as Snapshot;
      const was = snap.sale?.listPriceMinor ?? null;
      const work = works.get(i.artworkId);
      return {
        id: i.id,
        title: locale === "he" ? i.titleHe : i.titleEn,
        priceMinor: i.priceMinor,
        wasMinor: was !== null && was > i.priceMinor ? was : null,
        image: work?.image ?? null,
        dimensions:
          snap.heightMm && snap.widthMm
            ? {
                heightMm: snap.heightMm,
                widthMm: snap.widthMm,
                depthMm: snap.depthMm ?? null,
              }
            : null,
      };
    }),
    itemsTotalMinor: order.itemsTotalMinor,
    shippingMinor: order.shippingMinor,
    insuranceMinor: order.insuranceMinor,
    totalMinor: order.totalMinor,
    vatMinor: order.vatMinor,
    international: order.shipCountry !== "IL",
    holdUntil,
    maxInstallments:
      order.shipCountry === "IL" && order.currency === "ILS"
        ? Math.max(1, checkout.maxInstallments)
        : 1,
    prefill:
      provider?.mode === "LIVE" && order.buyerName && order.buyerEmail
        ? {
            name: order.buyerName,
            email: order.buyerEmail,
            phone: order.buyerPhone ?? "",
          }
        : null,
    client: provider ? provider.hostedFields.client() : null,
  };
}
