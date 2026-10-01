import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  env: {
    APP_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/unused",
    isProduction: false,
  },
}));

const { buildProvider, checkoutProviders, isProviderConfigured } = await import(
  "@/server/payments/registry"
);
const { ProviderNotConfiguredError } = await import(
  "@/server/integrations/http"
);
type Env = import("@/server/env").Env;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: "development",
    isProduction: false,
    DEMO_MODE: true,
    PAYMENT_PROVIDERS: ["mock", "cardcom", "paypal"],
    CARDCOM_MODE: "test",
    CARDCOM_TERMINAL_NUMBER: "1000",
    CARDCOM_API_NAME: "name",
    CARDCOM_API_PASSWORD: undefined,
    CARDCOM_CURRENCIES: ["ILS"],
    CARDCOM_WALLETS: ["bit"],
    PAYPAL_MODE: "sandbox",
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_MERCHANT_ID: "MERCHANT",
    TAX_DOCUMENTS_MODE: "mock",
    ...overrides,
  } as unknown as Env;
}

const base = {
  currency: "ILS" as const,
  destinationCountry: "IL",
  isDemo: true,
  paypalForIsraeliDestinations: false,
  liveBlocked: false,
};

const ids = (env: Env, i = {}) =>
  checkoutProviders({ ...base, ...i }, { env }).map((p) => p.id);

describe("payments registry", () => {
  it("keeps PAYMENT_PROVIDERS order and hides PayPal for Israeli destinations", () => {
    const env = makeEnv();
    expect(ids(env)).toEqual(["mock", "cardcom"]);
    expect(ids(env, { destinationCountry: "US" })).toEqual([
      "mock",
      "cardcom",
      "paypal",
    ]);
    expect(ids(env, { paypalForIsraeliDestinations: true })).toEqual([
      "mock",
      "cardcom",
      "paypal",
    ]);
  });

  it("filters by currency", () => {
    expect(
      ids(makeEnv(), { currency: "USD", destinationCountry: "US" }),
    ).toEqual(["mock", "paypal"]);
  });

  it("offers mock in production only for demo items with DEMO_MODE", () => {
    const prod = makeEnv({ APP_ENV: "production", isProduction: true });
    expect(ids(prod, { isDemo: true })).toContain("mock");
    expect(ids(prod, { isDemo: false })).not.toContain("mock");
    const prodLive = makeEnv({
      APP_ENV: "production",
      isProduction: true,
      DEMO_MODE: false,
    });
    expect(ids(prodLive, { isDemo: true })).not.toContain("mock");
  });

  it("refuses LIVE providers for demo items and while blocked", () => {
    const env = makeEnv({ CARDCOM_MODE: "live", DEMO_MODE: false });
    expect(ids(env, { isDemo: true })).not.toContain("cardcom");
    expect(ids(env, { isDemo: false, liveBlocked: true })).not.toContain(
      "cardcom",
    );
    expect(ids(env, { isDemo: false })).toContain("cardcom");
  });

  it("skips adapters without credentials", () => {
    const env = makeEnv({
      CARDCOM_MODE: "disabled",
      PAYPAL_MERCHANT_ID: undefined,
    });
    expect(isProviderConfigured("cardcom", env)).toBe(false);
    expect(buildProvider("paypal", { env })).toBeNull();
    expect(ids(env, { destinationCountry: "US" })).toEqual(["mock"]);
  });

  it("adapters expose identity and throw ProviderNotConfiguredError without usable credentials", async () => {
    const env = makeEnv();
    const cardcom = buildProvider("cardcom", { env });
    expect(cardcom?.merchantRef()).toBe("1000");
    expect(cardcom?.capabilities.wallets).toEqual(["bit"]);
    expect(cardcom?.capabilities.refunds).toBe("manual");
    // WS5: the adapter is real now; an unusable terminal number fails before any network call.
    const unusable = buildProvider("cardcom", {
      env: makeEnv({ CARDCOM_TERMINAL_NUMBER: "not-a-number" }),
    });
    await expect(
      unusable?.fetchPayment({ providerRef: "x", attemptId: "y" }),
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(buildProvider("paypal", { env })?.merchantRef()).toBe("MERCHANT");
  });
});
