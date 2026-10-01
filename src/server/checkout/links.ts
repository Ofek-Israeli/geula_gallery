import "server-only";
import { eq } from "drizzle-orm";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import { audit } from "@/server/audit";
import { type Db, db as defaultDb, type Tx } from "@/server/db/client";
import {
  buyerRequests,
  type Order,
  orderItems,
  orders,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  ValidationError,
} from "@/server/domain/errors";
import { newOrderNumber } from "@/server/domain/ids";
import {
  canRequestTransition,
  type RequestStatus,
} from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { env as defaultEnv, type Env } from "@/server/env";
import { enqueueEmail } from "@/server/outbox/enqueue";
import { getSetting } from "@/server/settings";
import { carrierFor } from "@/server/shipping/registry";
import type {
  ShippingMethod,
  ShippingQuoteResult,
} from "@/server/shipping/types";
import { detectConversation } from "./conversation";
import { orderItemValues } from "./items";
import { itemPriceMinor, orderAmounts, shippingOptions } from "./pricing";
import {
  allReservable,
  expireTakenOverOrders,
  lockArtworks,
  reserveArtworks,
  takeBuyerLocks,
} from "./reservations";
import { orderUrlFor } from "./start";
import type { BuyerDetails } from "./types";

/**
 * Link orders (spec §5.8, §5.10; frozen contract `createLinkOrder`). A quote answer, an accepted or
 * countered offer, or a manual distance order (WhatsApp, phone, email) becomes **one** order held
 * for the buyer (48 h by default) at a locked item price. The admin creates it; the buyer receives
 * the `checkout-link` email, completes the missing details on the order page (address, consents,
 * delivery method when it is not locked) and pays through `startPaymentForOrder`, which extends
 * the hold to `greatest(reserved_until, now()+reservationMinutes)`. Payment → the request becomes
 * CONVERTED; expiry → EXPIRED. Country and currency are fixed (IL ⇒ ILS).
 *
 * One transaction: lock the artwork (reservable; the admin may bypass `quote_only` and
 * `price_on_request`) → advisory buyer locks → insert the order and its item → reserve (row count
 * checked) → takeover expiry → the request transition → the `checkout-link` email → audit. Link
 * orders are the painter's decision, so the WEB anti-hoarding caps do not apply.
 */
export interface CreateLinkOrderInput {
  kind: "QUOTE" | "OFFER" | "MANUAL";
  artworkId: string;
  buyer: BuyerDetails;
  country: string;
  currency: Currency;
  itemPriceMinor: number;
  lockedShippingMinor?: number;
  shippingMethod?: ShippingMethod;
  conversationTookPlace: boolean;
  expiresInHours?: number;
  locale: Locale;
  /** The inbox request this link answers (moves to QUOTED / ACCEPTED / COUNTERED). */
  requestId?: string;
  /** Required when the price differs from the list price (spec §5.10). */
  priceChangeReason?: string;
}

export interface LinkDeps {
  db?: Db;
  env?: Env;
}

/** Longest hold the admin may give a link (two weeks); the default comes from settings (48 h). */
export const MAX_LINK_HOURS = 14 * 24;

/**
 * A shipping quote the admin locked by hand (a QUOTED method, or a fixed amount for any method):
 * no engine price, no insurance, the engine's destination notices for that country.
 */
export function lockedShippingQuote(i: {
  method: ShippingMethod;
  shippingMinor: number;
  currency: Currency;
  notices: ShippingQuoteResult["notices"];
}): ShippingQuoteResult {
  return {
    mode: "ok",
    notices: i.notices,
    zone: null,
    method: i.method,
    carrier: null,
    sizeClass: "QUOTE",
    chargeableG: 0,
    currency: i.currency,
    shippingMinor: i.shippingMinor,
    insuranceMinor: 0,
    insured: false,
    insuredValueMinor: 0,
    breakdown: {
      baseMinor: i.shippingMinor,
      pieceFeesMinor: 0,
      surchargesMinor: 0,
    },
  };
}

function assertMinorAmount(
  n: number | undefined,
  code: string,
  min: number,
): void {
  if (n === undefined) return;
  if (!Number.isInteger(n) || n < min) {
    throw new ValidationError(code, `${code}: expected an integer ≥ ${min}`);
  }
}

class NumberCollision extends Error {}

export async function createLinkOrder(
  input: CreateLinkOrderInput,
  ctx: AdminContext,
  deps: LinkDeps = {},
): Promise<
  ServiceResult<{ orderId: string; orderNumber: string; linkUrl: string }>
> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const country = input.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new ValidationError("COUNTRY", "a two-letter country code");
  }
  if (country === "IL" && input.currency !== "ILS") {
    throw new ValidationError("IL_REQUIRES_ILS", "Israel pays in ILS");
  }
  assertMinorAmount(input.itemPriceMinor, "ITEM_PRICE", 1);
  assertMinorAmount(input.lockedShippingMinor, "LOCKED_SHIPPING", 0);
  if (!input.buyer.email.trim() || !input.buyer.name.trim()) {
    throw new ValidationError("BUYER", "buyer name and email are required");
  }
  const checkout = await getSetting("checkout", db);
  const hours = input.expiresInHours ?? checkout.linkHoursDefault;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_LINK_HOURS) {
    throw new ValidationError("EXPIRES_IN_HOURS", "between 1 and 336 hours");
  }

  for (let round = 1; round <= 3; round++) {
    try {
      const order = await withTx(
        (tx) => createLinkOrderTx(tx, { input, country, hours, ctx, env: e }),
        { db, name: "checkout.link_order" },
      );
      return withEffects(
        {
          orderId: order.id,
          orderNumber: order.number,
          linkUrl: orderUrlFor(order, input.locale, {}, e),
        },
        { outbox: true, revalidate: true },
      );
    } catch (error) {
      if (error instanceof NumberCollision && round < 3) continue;
      throw error;
    }
  }
  throw new Error("createLinkOrder: no order number");
}

async function createLinkOrderTx(
  tx: Tx,
  i: {
    input: CreateLinkOrderInput;
    country: string;
    hours: number;
    ctx: AdminContext;
    env: Env;
  },
): Promise<Order> {
  const { input, country } = i;
  const now = new Date();

  // 1. Lock the artwork before any FK insert that references it; reservable without the WEB-only
  //    `quote_only` / `price_on_request` conditions.
  const locked = await lockArtworks(tx, [input.artworkId]);
  const art = locked[0];
  if (!art) throw new NotFoundError("artwork", input.artworkId);
  if (!(await allReservable(tx, locked, null, false, now))) {
    throw new ConflictError(
      "ARTWORK_NOT_RESERVABLE",
      "the work is not available, or another buyer holds it",
    );
  }
  if (input.kind !== "OFFER") {
    const list = itemPriceMinor(art, input.currency);
    if (
      list !== null &&
      list !== input.itemPriceMinor &&
      !input.priceChangeReason?.trim()
    ) {
      throw new ValidationError(
        "PRICE_CHANGE_REASON_REQUIRED",
        "a price different from the list price needs a reason",
      );
    }
  }

  // 2. Shipping: a locked amount, or the table price of the chosen (or first) method.
  const shippingSettings = await getSetting("shipping", tx);
  const checkout = await getSetting("checkout", tx);
  const profile = await getSetting("business_profile", tx);
  const options = shippingOptions({
    items: [art],
    country,
    currency: input.currency,
    date: now,
    shipping: shippingSettings,
    checkout,
    carrier: carrierFor(country, { env: i.env }),
  });
  if (options.all.every((q) => q.reason === "DESTINATION_DENIED")) {
    throw new ValidationError("DESTINATION_DENIED", "we do not ship there");
  }
  let quote: ShippingQuoteResult;
  let shippingLocked: boolean;
  if (input.lockedShippingMinor !== undefined) {
    quote = lockedShippingQuote({
      method: input.shippingMethod ?? "QUOTED",
      shippingMinor: input.lockedShippingMinor,
      currency: input.currency,
      notices: options.all[0]?.notices ?? [],
    });
    shippingLocked = true;
  } else {
    const picked = input.shippingMethod
      ? options.ok.find((q) => q.method === input.shippingMethod)
      : options.ok[0];
    if (!picked) {
      throw new ValidationError(
        "SHIPPING_QUOTE_REQUIRED",
        "no table price for this destination: lock a shipping amount",
      );
    }
    quote = picked;
    shippingLocked = false;
  }
  const amounts = orderAmounts({
    itemsTotalMinor: input.itemPriceMinor,
    quote,
    vatMode: profile.vatMode,
    country,
    date: now,
  });

  // 3. Advisory buyer locks (same order as the WEB checkout), then conversation detection.
  await takeBuyerLocks(tx, { email: input.buyer.email, ipHash: null });
  const detected = await detectConversation(tx, {
    email: input.buyer.email,
    lookbackDays: checkout.conversationLookbackDays,
    now,
  });
  // The request this link answers is itself a conversation (the detection default, spec §5.1 5).
  const conversationTookPlace =
    input.conversationTookPlace ||
    detected.tookPlace ||
    Boolean(input.requestId);
  const ownSource = input.conversationTookPlace
    ? input.kind === "MANUAL"
      ? "ADMIN"
      : "LINK"
    : null;
  const conversationSource = input.requestId
    ? `REQUEST:${input.requestId}`
    : (detected.source ?? ownSource);

  // 4. The order and its item.
  const until = new Date(now.getTime() + i.hours * 60 * 60_000);
  const reason = input.priceChangeReason?.trim();
  let order: Order | undefined;
  try {
    [order] = await tx
      .insert(orders)
      .values({
        number: newOrderNumber(),
        source: input.kind,
        status: "AWAITING_PAYMENT",
        locale: input.locale,
        currency: input.currency,
        isDemo: art.isDemo,
        itemsTotalMinor: amounts.itemsTotalMinor,
        shippingMinor: amounts.shippingMinor,
        insuranceMinor: amounts.insuranceMinor,
        totalMinor: amounts.totalMinor,
        vatMode: profile.vatMode,
        vatRateBp: amounts.vatRateBp,
        vatMinor: amounts.vatMinor,
        fxIlsPerUnit:
          input.currency === "USD" ? String(checkout.fx.ilsPerUsd) : null,
        quoteVersion: 1,
        buyerName: input.buyer.name.trim(),
        buyerEmail: input.buyer.email.trim(),
        buyerPhone: input.buyer.phone?.trim() || null,
        buyerCompanyName: input.buyer.companyName ?? null,
        buyerVatId: input.buyer.vatId ?? null,
        shipCountry: country,
        shippingMethod: quote.method,
        shippingQuote: quote,
        shippingLocked,
        conversationTookPlace,
        conversationSource,
        disclosureVersion: LEGAL_VERSIONS.disclosure,
        expiresAt: until,
        holdCount: 1,
        firstHeldAt: now,
        adminNotes: reason ? `Price change: ${reason}` : null,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error, "orders_number_unique")) {
      throw new NumberCollision();
    }
    throw error;
  }
  if (!order) throw new Error("order insert returned no row");
  await tx
    .insert(orderItems)
    .values(
      orderItemValues(order.id, art, input.itemPriceMinor, input.currency),
    );

  // 5. Reserve (row count must be 1) and expire a taken-over lapsed hold.
  const reserved = await reserveArtworks(tx, {
    artworkIds: [art.id],
    orderId: order.id,
    until,
    web: false,
  });
  if (!reserved) {
    throw new ConflictError("ARTWORK_NOT_RESERVABLE", "the work was taken");
  }
  await expireTakenOverOrders(
    tx,
    locked.map((a) => a.reservedByOrderId),
    order.id,
  );

  // 6. The request this link answers.
  if (input.requestId) {
    await linkRequest(tx, input, order, i.ctx.actor);
  }

  // 7. The checkout-link email and the audit row.
  await enqueueEmail(tx, {
    template: "checkout-link",
    to: order.buyerEmail ?? input.buyer.email,
    locale: input.locale,
    refId: order.id,
  });
  await audit(
    {
      actor: i.ctx.actor,
      action: "order.link_created",
      entity: "order",
      entityId: order.id,
      after: {
        number: order.number,
        kind: input.kind,
        artworkId: art.id,
        itemPriceMinor: input.itemPriceMinor,
        listPriceMinor: itemPriceMinor(art, input.currency),
        priceChangeReason: reason ?? null,
        currency: input.currency,
        country,
        method: quote.method,
        shippingLocked,
        totalMinor: order.totalMinor,
        expiresAt: until.toISOString(),
        requestId: input.requestId ?? null,
        conversationTookPlace,
      },
      ipHash: i.ctx.ipHash,
    },
    tx,
  );
  return order;
}

async function linkRequest(
  tx: Tx,
  input: CreateLinkOrderInput,
  order: Order,
  actor: string,
): Promise<void> {
  const requestId = input.requestId as string;
  const [request] = await tx
    .select()
    .from(buyerRequests)
    .where(eq(buyerRequests.id, requestId))
    .for("update");
  if (!request) throw new NotFoundError("buyer_request", requestId);
  if (request.orderId !== null) {
    throw new ConflictError(
      "REQUEST_ALREADY_LINKED",
      "this request already has a link order",
    );
  }
  if (request.artworkId !== null && request.artworkId !== input.artworkId) {
    throw new ValidationError(
      "REQUEST_ARTWORK_MISMATCH",
      "the request is about another work",
    );
  }
  if (request.kind === "QUESTION") {
    // A question answered by a manual order: linked for the timeline; its status is the inbox's.
    await tx
      .update(buyerRequests)
      .set({ orderId: order.id })
      .where(eq(buyerRequests.id, request.id));
    return;
  }
  const to: RequestStatus =
    request.kind === "QUOTE"
      ? "QUOTED"
      : request.offerAmountMinor === input.itemPriceMinor &&
          request.offerCurrency === input.currency
        ? "ACCEPTED"
        : "COUNTERED";
  if (!canRequestTransition(request.kind, request.status, to)) {
    throw new ConflictError(
      "REQUEST_NOT_OPEN",
      `the request is ${request.status}`,
    );
  }
  await transition(
    tx,
    "buyerRequest",
    request.id,
    [request.status],
    to,
    { orderId: order.id },
    actor,
    { action: `request.${to.toLowerCase()}` },
  );
}
