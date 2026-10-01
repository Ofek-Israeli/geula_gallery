/**
 * Commerce test factories (WS2-owned, spec §9.3: streams add `factories/<stream>.ts`).
 *
 * Builders that drive the real services (checkout, mock hosted page, finalize) so integration
 * tests arrange state the way production does. App modules are imported lazily, like
 * `factories/core.ts`, so importing this file never parses the app environment.
 */
import { randomUUID } from "node:crypto";
import type { Db, DbOrTx } from "@/server/db/client";
import { insertArtwork, uniqueBuyer } from "./core";

type Schema = typeof import("@/server/db/schema");
type ArtworkInsert = Schema["artworks"]["$inferInsert"];
type ArtworkRow = Schema["artworks"]["$inferSelect"];
type StartInput = import("@/server/checkout/types").StartCheckoutInput;
type StartResult = import("@/server/checkout/types").StartCheckoutResult;
type MockAction = import("@/server/payments/providers/mock").MockPageAction;

/** A published, priced demo work that the WEB checkout can sell (ILS ₪1,500, USD $400). */
export async function buyableArtwork(
  db: DbOrTx,
  overrides: Partial<ArtworkInsert> = {},
): Promise<ArtworkRow> {
  return insertArtwork(db, {
    isDemo: true,
    priceIlsMinor: 150_000,
    priceUsdMinor: 40_000,
    ...overrides,
  });
}

export interface CheckoutOptions {
  db?: Db;
  buyer?: { name: string; email: string; phone: string };
  ipHash?: string | null;
  country?: string;
  method?: "CARRIER_TABLE" | "LOCAL_PICKUP" | "ARTIST_DELIVERY";
  currency?: "ILS" | "USD";
  clientRequestId?: string;
  locale?: "he" | "en";
}

/** A complete, valid `StartCheckoutInput` priced by the server quote (IL pickup by default). */
export async function checkoutInput(
  slug: string,
  opts: CheckoutOptions = {},
): Promise<StartInput> {
  const { getCheckoutQuote } = await import("@/server/checkout/quote");
  const { LEGAL_VERSIONS } = await import("@/content/legal/versions");
  const country = opts.country ?? "IL";
  const method =
    opts.method ?? (country === "IL" ? "LOCAL_PICKUP" : "CARRIER_TABLE");
  const locale = opts.locale ?? "he";
  const quote = await getCheckoutQuote(
    { slug, locale, country, method, currency: opts.currency },
    { db: opts.db },
  );
  if (quote.kind !== "ok") {
    throw new Error(`checkoutInput: quote blocked (${quote.reason})`);
  }
  const buyer = opts.buyer ?? uniqueBuyer();
  return {
    slug,
    locale,
    country,
    method: quote.shipping.method as StartInput["method"],
    currency: quote.currency,
    providerId: "mock",
    buyer: { name: buyer.name, email: buyer.email, phone: "+97230000000" },
    shipTo:
      method === "LOCAL_PICKUP"
        ? null
        : {
            name: "Test Buyer",
            line1: "1 Test Street",
            city: country === "IL" ? "Tel Aviv" : "Springfield",
            postalCode: "12345",
            country,
            phone: "+97230000000",
          },
    expectedTotalMinor: quote.totalMinor,
    clientRequestId: opts.clientRequestId ?? randomUUID(),
    consents: {
      termsVersion: LEGAL_VERSIONS.terms,
      returnsVersion: LEGAL_VERSIONS.returns,
      privacyVersion: LEGAL_VERSIONS.privacy,
      ageConfirmed: true,
      ...(country === "IL"
        ? {}
        : { dutiesNoticeVersion: LEGAL_VERSIONS.dutiesNotice }),
      receiptEmailConsent: true,
    },
    ipHash: opts.ipHash === undefined ? `ip-${randomUUID()}` : opts.ipHash,
  };
}

/** `startCheckout` with a valid input; returns the result and the input used. */
export async function startTestCheckout(
  slug: string,
  opts: CheckoutOptions = {},
): Promise<{ result: StartResult; input: StartInput }> {
  const { startCheckout } = await import("@/server/checkout/start");
  const input = await checkoutInput(slug, opts);
  const { result } = await startCheckout(input, { db: opts.db });
  return { result, input };
}

/** Starts a checkout and returns the order, its first attempt and the mock payment ref. */
export async function heldOrder(
  slug: string,
  opts: CheckoutOptions = {},
): Promise<{
  orderId: string;
  attemptId: string;
  ref: string;
  input: StartInput;
}> {
  const { result, input } = await startTestCheckout(slug, opts);
  if (result.kind !== "redirect") {
    throw new Error(`heldOrder: checkout did not redirect (${result.kind})`);
  }
  const { latestAttempt } = await attemptHelpers();
  const attempt = await latestAttempt(result.orderId);
  if (!attempt.providerRef) throw new Error("heldOrder: no provider ref");
  return {
    orderId: result.orderId,
    attemptId: attempt.id,
    ref: attempt.providerRef,
    input,
  };
}

async function attemptHelpers() {
  const [{ db }, { paymentAttempts }, { desc, eq }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/db/schema"),
    import("drizzle-orm"),
  ]);
  return {
    async latestAttempt(orderId: string) {
      const [row] = await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, orderId))
        .orderBy(desc(paymentAttempts.seq))
        .limit(1);
      if (!row) throw new Error("no attempt");
      return row;
    },
  };
}

/** A button on the mock hosted page, without sending the webhook (tests call finalize). */
export async function clickMockPay(ref: string, action: MockAction = "pay") {
  const { applyMockPageAction } = await import(
    "@/server/payments/providers/mock"
  );
  return applyMockPageAction(ref, action, { notify: async () => {} });
}

/** Merge a patch into a settings row (tests only). */
export async function patchSetting(
  key: "checkout" | "shipping" | "business_profile",
  patch: Record<string, unknown>,
): Promise<void> {
  const [{ db }, { settings }, { eq, sql }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/db/schema"),
    import("drizzle-orm"),
  ]);
  await db
    .update(settings)
    .set({ value: sql`${settings.value} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(settings.key, key));
}

/** Run raw SQL on the app pool (arranging time-dependent state). */
export async function execSql(text: string, params: unknown[] = []) {
  const { pool } = await import("@/server/db/client");
  return pool.query(text, params);
}

// ---------------------------------------------------------------- admin and link orders (M3)

type AdminContext = import("@/server/domain/admin").AdminContext;
type LinkInput = import("@/server/checkout/links").CreateLinkOrderInput;
type RequestInsert = Schema["buyerRequests"]["$inferInsert"];

/** A fresh admin context (the guard's output) for service calls in tests. */
export function testAdminContext(
  overrides: Partial<Record<keyof AdminContext, unknown>> = {},
): AdminContext {
  return {
    userId: "u-admin",
    email: "painter@example.test",
    name: "Painter",
    sessionId: "s-test",
    sessionCreatedAt: new Date(),
    twoFactorEnabled: true,
    locale: "he",
    ipHash: null,
    actor: "admin:u-admin",
    ...overrides,
  } as unknown as AdminContext;
}

/** An inbox request (QUOTE by default) about `artworkId`. */
export async function insertBuyerRequest(
  db: DbOrTx,
  overrides: Partial<RequestInsert> = {},
) {
  const { buyerRequests } = await import("@/server/db/schema");
  const buyer = uniqueBuyer("req");
  const [row] = await db
    .insert(buyerRequests)
    .values({
      kind: "QUOTE",
      name: buyer.name,
      email: buyer.email,
      locale: "en",
      message: "Could you quote delivery?",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertBuyerRequest: no row");
  return row;
}

/** `createLinkOrder` (MANUAL, IL, ILS at the list price, pickup) with overrides. */
export async function linkOrder(
  art: ArtworkRow,
  overrides: Partial<LinkInput> = {},
  ctx: AdminContext = testAdminContext(),
) {
  const { createLinkOrder } = await import("@/server/checkout/links");
  const buyer = uniqueBuyer("link");
  const currency = overrides.currency ?? "ILS";
  const { result } = await createLinkOrder(
    {
      kind: "MANUAL",
      artworkId: art.id,
      buyer: { name: buyer.name, email: buyer.email, phone: "+97230000000" },
      country: "IL",
      currency,
      itemPriceMinor:
        (currency === "ILS" ? art.priceIlsMinor : art.priceUsdMinor) ?? 100_000,
      shippingMethod: "LOCAL_PICKUP",
      conversationTookPlace: true,
      locale: "en",
      ...overrides,
    },
    ctx,
  );
  return result;
}

/** The buyer completes a link order's details (pickup by default; an address otherwise). */
export async function completeDetails(
  orderId: string,
  opts: {
    method?: "CARRIER_TABLE" | "LOCAL_PICKUP" | "ARTIST_DELIVERY" | "QUOTED";
    country?: string;
    duties?: boolean;
  } = {},
) {
  const { completeLinkOrderDetails } = await import(
    "@/server/checkout/link-details"
  );
  const { LEGAL_VERSIONS } = await import("@/content/legal/versions");
  const country = opts.country ?? "IL";
  const { result } = await completeLinkOrderDetails({
    orderId,
    ...(opts.method ? { method: opts.method } : {}),
    shipTo:
      opts.method === "LOCAL_PICKUP"
        ? null
        : {
            name: "Test Buyer",
            line1: "1 Test Street",
            city: country === "IL" ? "Tel Aviv" : "Springfield",
            postalCode: "12345",
            country,
            phone: "+97230000000",
          },
    buyer: {},
    consents: {
      termsVersion: LEGAL_VERSIONS.terms,
      returnsVersion: LEGAL_VERSIONS.returns,
      privacyVersion: LEGAL_VERSIONS.privacy,
      ageConfirmed: true,
      ...((opts.duties ?? country !== "IL")
        ? { dutiesNoticeVersion: LEGAL_VERSIONS.dutiesNotice }
        : {}),
      receiptEmailConsent: true,
    },
    actor: "buyer:test",
    ipHash: null,
  });
  return result;
}

/** "Pay" on the order page with the mock provider; returns the new attempt and its mock ref. */
export async function payOrder(orderId: string, opts: { db?: Db } = {}) {
  const { startPaymentForOrder } = await import("@/server/checkout/start");
  const { result } = await startPaymentForOrder(
    { orderId, providerId: "mock", locale: "en", ipHash: null },
    { db: opts.db },
  );
  if (result.kind !== "redirect") return { result, attempt: null };
  const { latestAttempt } = await attemptHelpers();
  const attempt = await latestAttempt(orderId);
  return { result, attempt };
}
