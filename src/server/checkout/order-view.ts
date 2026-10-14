import "server-only";
import { asc, eq } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import { localePath, paths } from "@/lib/routes";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  cancellationItems,
  cancellations,
  orderItems,
  orders,
  paymentAttempts,
} from "@/server/db/schema";
import {
  type AttemptStatus,
  IN_FLIGHT_ATTEMPT_STATUSES,
  type OrderStatus,
} from "@/server/domain/state-machines";
import { env as defaultEnv, type Env } from "@/server/env";
import { isPendingSaleRef } from "@/server/payments/providers/isracard-map";
import type { ProviderId } from "@/server/payments/types";
import { hmacToken, verifyOrderAccessToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { orderDetailsComplete } from "./link-details";
import { insuredValueForDisplay } from "./pricing";
import { orderPaymentProviders } from "./providers";
import { shippingChoicesForOrder } from "./requote";

/**
 * The buyer's order page data (spec §5.1 step 4): readable only with the `?k=` access token
 * (HMAC of `orderId:accessVersion`). No PII beyond what the buyer typed; never cached.
 */
export interface BuyerOrderView {
  id: string;
  number: string;
  accessToken: string;
  status: OrderStatus;
  statusReason: string | null;
  locale: Locale;
  currency: Currency;
  itemsTotalMinor: number;
  shippingMinor: number;
  insuranceMinor: number;
  totalMinor: number;
  shippingMethod: string;
  shipCountry: string;
  isDemo: boolean;
  /** ISO; the live hold of an AWAITING_PAYMENT order (null when not held). */
  holdUntil: string | null;
  items: {
    artworkId: string;
    title: string;
    slug: string | null;
    priceMinor: number;
    /** The buyer's accepted cancellation number when this work was cancelled. */
    cancelledBy: string | null;
  }[];
  attempts: {
    seq: number;
    status: AttemptStatus;
    provider: string;
    createdAt: string;
  }[];
  /** An attempt is CAPTURING or PAYMENT_REVIEW: pay and release are refused. */
  inFlight: boolean;
  /** An attempt started in the last 2 minutes is still waiting for the provider. */
  recentPending: boolean;
  /**
   * Locale-prefixed: the latest attempt's own pay page (Isracard hosted fields), when it was never
   * submitted and the hold is live. "Pay now" opens it (a full page load) instead of a new attempt.
   */
  payPageUrl: string | null;
  canPay: boolean;
  canRelease: boolean;
  providers: ProviderId[];
  /** A QUOTE / OFFER / MANUAL link order (spec §5.8). */
  isLink: boolean;
  /** Address and consents are on the order (always true for WEB orders). */
  detailsComplete: boolean;
  /** An open link order: the buyer may (re)enter the delivery details. */
  canEditDetails: boolean;
  /** The painter fixed the shipping amount: the method cannot change. */
  shippingLocked: boolean;
  /** Methods the buyer may pick on an open, unlocked link order (prices in the order currency). */
  methodChoices: {
    method: string;
    priceMinor: number;
    insured: boolean;
    insuredValueMinor: number;
    estimate: string | null;
  }[];
  /** The saved delivery address (the buyer's own input; token-protected page). */
  address: {
    name: string;
    line1: string;
    line2: string;
    city: string;
    region: string;
    postalCode: string;
  } | null;
  receiptEmailConsent: boolean;
}

export async function getBuyerOrder(
  number: string,
  token: string | null,
  locale: Locale,
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<BuyerOrderView | null> {
  const db = deps.db ?? defaultDb;
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.number, number));
  if (!order) return null;
  if (!verifyOrderAccessToken(order.id, order.accessVersion, token))
    return null;

  const items = await db
    .select({
      artworkId: orderItems.artworkId,
      cancelledBy: cancellations.number,
      titleHe: orderItems.titleHe,
      titleEn: orderItems.titleEn,
      priceMinor: orderItems.priceMinor,
      slug: artworks.slug,
      reservedBy: artworks.reservedByOrderId,
      reservedUntil: artworks.reservedUntil,
    })
    .from(orderItems)
    .leftJoin(artworks, eq(artworks.id, orderItems.artworkId))
    .leftJoin(
      cancellationItems,
      eq(cancellationItems.orderItemId, orderItems.id),
    )
    .leftJoin(
      cancellations,
      eq(cancellations.id, cancellationItems.cancellationId),
    )
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.titleEn), asc(orderItems.id));
  const attempts = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.id))
    .orderBy(asc(paymentAttempts.seq));

  const now = Date.now();
  const inFlight = attempts.some((a) =>
    (IN_FLIGHT_ATTEMPT_STATUSES as readonly string[]).includes(a.status),
  );
  const held = items.every(
    (i) =>
      i.reservedBy === order.id &&
      i.reservedUntil !== null &&
      i.reservedUntil.getTime() > now,
  );
  const holdUntil =
    order.status === "AWAITING_PAYMENT" && held && items.length > 0
      ? new Date(
          Math.min(...items.map((i) => i.reservedUntil?.getTime() ?? now)),
        ).toISOString()
      : null;
  // An Isracard pay page that was never submitted waits for the buyer, not for the provider.
  const recentPending = attempts.some(
    (a) =>
      (a.status === "PENDING" || a.status === "CREATED") &&
      !isPendingSaleRef(a.providerRef) &&
      now - a.createdAt.getTime() < 2 * 60_000,
  );
  const latest = attempts.reduce<(typeof attempts)[number] | null>(
    (last, a) => (!last || a.seq > last.seq ? a : last),
    null,
  );
  const checkout = await getSetting("checkout", db);
  const providers =
    order.status === "AWAITING_PAYMENT"
      ? (
          await orderPaymentProviders(order, {
            db,
            env: deps.env ?? defaultEnv,
          })
        ).map((p) => p.id)
      : [];
  const awaiting = order.status === "AWAITING_PAYMENT";
  const isLink = order.source !== "WEB";
  const detailsComplete = !isLink || orderDetailsComplete(order);
  const canEditDetails = isLink && awaiting && !inFlight;
  const methodChoices =
    canEditDetails && !order.shippingLocked
      ? (await shippingChoicesForOrder(order.id, {}, { db, env: deps.env }))
          .filter((q) => q.mode === "ok")
          .map((q) => ({
            method: q.method,
            priceMinor: q.shippingMinor + q.insuranceMinor,
            insured: q.insured,
            insuredValueMinor: insuredValueForDisplay(
              q,
              order.currency,
              checkout.fx.ilsPerUsd,
            ),
            estimate: q.estimate?.[locale] ?? null,
          }))
      : [];
  return {
    id: order.id,
    number: order.number,
    accessToken: token ?? "",
    status: order.status,
    statusReason: order.statusReason,
    locale,
    currency: order.currency,
    itemsTotalMinor: order.itemsTotalMinor,
    shippingMinor: order.shippingMinor,
    insuranceMinor: order.insuranceMinor,
    totalMinor: order.totalMinor,
    shippingMethod: order.shippingMethod,
    shipCountry: order.shipCountry,
    isDemo: order.isDemo,
    holdUntil,
    items: items.map((i) => ({
      artworkId: i.artworkId,
      title: locale === "he" ? i.titleHe : i.titleEn,
      slug: i.slug,
      priceMinor: i.priceMinor,
      cancelledBy: i.cancelledBy ?? null,
    })),
    attempts: attempts.map((a) => ({
      seq: a.seq,
      status: a.status,
      provider: a.provider,
      createdAt: a.createdAt.toISOString(),
    })),
    inFlight,
    recentPending,
    payPageUrl:
      order.status === "AWAITING_PAYMENT" &&
      holdUntil !== null &&
      latest?.provider === "ISRACARD" &&
      latest.status === "PENDING" &&
      isPendingSaleRef(latest.providerRef)
        ? localePath(
            locale,
            paths.payPage(latest.id, hmacToken("isracard-pay", latest.id)),
          )
        : null,
    canPay:
      awaiting &&
      !inFlight &&
      detailsComplete &&
      providers.length > 0 &&
      attempts.length < checkout.maxAttemptsPerOrder,
    canRelease: awaiting && !inFlight,
    providers,
    isLink,
    detailsComplete,
    canEditDetails,
    shippingLocked: order.shippingLocked,
    methodChoices,
    address: order.shipLine1
      ? {
          name: order.shipName ?? "",
          line1: order.shipLine1,
          line2: order.shipLine2 ?? "",
          city: order.shipCity ?? "",
          region: order.shipRegion ?? "",
          postalCode: order.shipPostalCode ?? "",
        }
      : null,
    receiptEmailConsent: order.receiptEmailConsent ?? false,
  };
}

/** The order id behind a buyer token (actions re-verify before acting). */
export async function orderIdForToken(
  number: string,
  token: string | null,
  db: DbOrTx = defaultDb,
): Promise<{ id: string; accessVersion: number } | null> {
  const [order] = await db
    .select({ id: orders.id, accessVersion: orders.accessVersion })
    .from(orders)
    .where(eq(orders.number, number));
  if (!order) return null;
  return verifyOrderAccessToken(order.id, order.accessVersion, token)
    ? order
    : null;
}
