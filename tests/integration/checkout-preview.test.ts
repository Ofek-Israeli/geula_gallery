import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach, testEnv } from "../helpers/db";
import { buyableArtwork, checkoutInput } from "../helpers/factories/commerce";

/**
 * The checkout preview (`CHECKOUT_PREVIEW=true` with `SALES_OPEN=false`, docs/deploy.md "Checkout
 * preview and Isracard"): the purchase flow is public while online payment is not active.
 * - without a usable provider the quote is ok with no payment method ("activation pending") and a
 *   submitted checkout creates no order, attempt or hold;
 * - a live provider is never offered in the preview, a TEST one is;
 * - an open store without a provider is still blocked with NO_PROVIDER.
 */
const { db } = await import("@/server/db/client");
const { artworks, orders, paymentAttempts } = await import(
  "@/server/db/schema"
);
const { parseEnv } = await import("@/server/env");
const { getCheckoutQuote, liveProvidersBlocked } = await import(
  "@/server/checkout/quote"
);
const { startCheckout } = await import("@/server/checkout/start");

cleanDatabaseBeforeEach();

const preview = { ...testEnv(), SALES_OPEN: "false", CHECKOUT_PREVIEW: "true" };

/** PayPal is configured but hidden for an Israeli destination: no usable provider at all. */
const paypalOnly = {
  PAYMENT_PROVIDERS: "paypal",
  PAYPAL_MODE: "sandbox",
  PAYPAL_CLIENT_ID: "test-paypal-client-id",
  PAYPAL_CLIENT_SECRET: "test-paypal-client-secret",
  PAYPAL_MERCHANT_ID: "test-paypal-merchant",
};

const cardcom = (mode: "test" | "live") => ({
  PAYMENT_PROVIDERS: "cardcom",
  CARDCOM_MODE: mode,
  CARDCOM_TERMINAL_NUMBER: "1000",
  CARDCOM_API_NAME: "test-api-name",
  CARDCOM_API_PASSWORD: "test-api-password",
});

describe("checkout preview (CHECKOUT_PREVIEW=true)", () => {
  it("derives the access level from SALES_OPEN and CHECKOUT_PREVIEW", () => {
    expect(parseEnv(testEnv()).salesAccess).toBe("open");
    expect(parseEnv({ ...testEnv(), SALES_OPEN: "false" }).salesAccess).toBe(
      "closed",
    );
    expect(parseEnv(preview).salesAccess).toBe("preview");
  });

  it("without a usable provider: an ok quote with no payment method, and a checkout creates nothing", async () => {
    const env = parseEnv({ ...preview, ...paypalOnly });
    const art = await buyableArtwork(db);
    const quote = await getCheckoutQuote(
      { slug: art.slug, locale: "en", country: "IL", method: "LOCAL_PICKUP" },
      { env },
    );
    expect(quote).toMatchObject({ kind: "ok", providers: [] });

    const input = await checkoutInput(art.slug, { env, providerId: "paypal" });
    const { result } = await startCheckout(input, { env });
    expect(result).toEqual({ kind: "refused", code: "provider_unavailable" });
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(paymentAttempts)).toEqual([]);
    const [row] = await db.select().from(artworks);
    expect(row).toMatchObject({
      saleStatus: "AVAILABLE",
      reservedByOrderId: null,
    });
  });

  it("never offers a live provider, and offers a TEST one", async () => {
    const real = await buyableArtwork(db, { isDemo: false });
    const live = parseEnv({
      ...preview,
      DEMO_MODE: "false",
      ...cardcom("live"),
    });
    expect(await liveProvidersBlocked(db, live)).toBe(true);
    expect(
      await getCheckoutQuote(
        { slug: real.slug, locale: "en", country: "IL" },
        { env: live },
      ),
    ).toMatchObject({ kind: "ok", providers: [] });

    const test = parseEnv({
      ...preview,
      DEMO_MODE: "false",
      ...cardcom("test"),
    });
    const quote = await getCheckoutQuote(
      { slug: real.slug, locale: "en", country: "IL" },
      { env: test },
    );
    expect(quote).toMatchObject({ kind: "ok" });
    expect(quote.kind === "ok" && quote.providers.map((p) => p.id)).toEqual([
      "cardcom",
    ]);
  });

  it("an open store without a provider is still blocked with NO_PROVIDER", async () => {
    const env = parseEnv({ ...testEnv(), ...paypalOnly });
    const art = await buyableArtwork(db);
    expect(
      await getCheckoutQuote(
        { slug: art.slug, locale: "en", country: "IL" },
        { env },
      ),
    ).toMatchObject({ kind: "blocked", reason: "NO_PROVIDER" });
  });

  it("a closed store is still blocked with SALES_CLOSED", async () => {
    const env = parseEnv({ ...testEnv(), SALES_OPEN: "false" });
    const art = await buyableArtwork(db);
    expect(
      await getCheckoutQuote(
        { slug: art.slug, locale: "en", country: "IL" },
        { env },
      ),
    ).toMatchObject({ kind: "blocked", reason: "SALES_CLOSED" });
  });
});
