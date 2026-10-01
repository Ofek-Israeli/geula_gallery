import "server-only";
import { raiseAlert } from "@/server/alerts/service";
import type { DbOrTx } from "@/server/db/client";
import { env as defaultEnv, type Env } from "@/server/env";
import type { FetchLike } from "@/server/integrations/http";
import { log } from "@/server/log";
import { createCardcomProvider } from "./providers/cardcom";
import { createMockProvider } from "./providers/mock";
import { createPaypalProvider } from "./providers/paypal";
import type {
  Currency,
  PaymentProvider,
  ProviderFactory,
  ProviderId,
  ProviderMode,
} from "./types";

/**
 * Payment provider registry (spec §4.2 "Registry"). WS2 owns this file after `contracts-v1`.
 * Every function takes optional `deps` so tests can pass their own env and fetch.
 */
export interface RegistryDeps {
  env?: Env;
  fetch?: FetchLike;
}

const FACTORIES: Record<ProviderId, ProviderFactory> = {
  mock: createMockProvider,
  cardcom: createCardcomProvider,
  paypal: createPaypalProvider,
};

/** True when the adapter is enabled and its credentials exist (no network). */
export function isProviderConfigured(id: ProviderId, e: Env): boolean {
  switch (id) {
    case "mock":
      return true;
    case "cardcom":
      return (
        e.CARDCOM_MODE !== "disabled" &&
        !!e.CARDCOM_TERMINAL_NUMBER &&
        !!e.CARDCOM_API_NAME
      );
    case "paypal":
      return (
        e.PAYPAL_MODE !== "disabled" &&
        !!e.PAYPAL_CLIENT_ID &&
        !!e.PAYPAL_CLIENT_SECRET &&
        !!e.PAYPAL_MERCHANT_ID
      );
  }
}

/**
 * Test seam: integration tests replace an adapter factory (a fixture-backed PayPal, a Cardcom
 * with `listTransactions`) without credentials. Ignored when `APP_ENV=production`.
 */
const testFactories = new Map<ProviderId, ProviderFactory>();

export function setProviderFactoryForTests(
  id: ProviderId,
  factory: ProviderFactory | null,
): void {
  if (factory) testFactories.set(id, factory);
  else testFactories.delete(id);
}

/** Builds an adapter whose credentials exist, or null. */
export function buildProvider(
  id: ProviderId,
  deps: RegistryDeps = {},
): PaymentProvider | null {
  const e = deps.env ?? defaultEnv;
  const override = e.isProduction ? undefined : testFactories.get(id);
  if (override) return override({ env: e, fetch: deps.fetch });
  if (!isProviderConfigured(id, e)) return null;
  return FACTORIES[id]({ env: e, fetch: deps.fetch });
}

export interface CheckoutProvidersInput {
  currency: Currency;
  destinationCountry: string;
  isDemo: boolean;
  /** `settings.checkout.paypalForIsraeliDestinations`. */
  paypalForIsraeliDestinations: boolean;
  /** Go-live blockers exist (`golive.ts`, WS6): live providers are refused. */
  liveBlocked: boolean;
}

/**
 * Providers offered at checkout, in `PAYMENT_PROVIDERS` order:
 * - filtered by currency;
 * - PayPal only for non-IL destinations unless the setting allows it;
 * - `mock` when `APP_ENV≠production`, or in production with `DEMO_MODE=true` for a demo item
 *   (never for real works in production);
 * - LIVE providers are refused for demo items and while go-live blockers exist.
 */
export function checkoutProviders(
  i: CheckoutProvidersInput,
  deps: RegistryDeps = {},
): PaymentProvider[] {
  const e = deps.env ?? defaultEnv;
  const out: PaymentProvider[] = [];
  for (const id of e.PAYMENT_PROVIDERS) {
    if (id === "mock" && e.isProduction && !(e.DEMO_MODE && i.isDemo)) continue;
    if (
      id === "paypal" &&
      i.destinationCountry === "IL" &&
      !i.paypalForIsraeliDestinations
    ) {
      continue;
    }
    const provider = buildProvider(id, deps);
    if (!provider) continue;
    if (!provider.capabilities.currencies.includes(i.currency)) continue;
    if (provider.mode === "LIVE" && (i.isDemo || i.liveBlocked)) continue;
    out.push(provider);
  }
  return out;
}

/** The attempt columns `providerForAttempt` needs. */
export interface AttemptProviderRef {
  id: string;
  provider: "MOCK" | "CARDCOM" | "PAYPAL" | "OFFLINE";
  providerMode: ProviderMode | "MANUAL";
  merchantRef: string | null;
}

export type ProviderForAttempt =
  | { kind: "ok"; provider: PaymentProvider }
  | { kind: "offline" }
  | { kind: "not_configured"; providerId: ProviderId }
  | {
      kind: "config_drift";
      providerId: ProviderId;
      expected: { mode: string; merchantRef: string | null };
      actual: { mode: string; merchantRef: string | null };
    };

const ID_FROM_DB = {
  MOCK: "mock",
  CARDCOM: "cardcom",
  PAYPAL: "paypal",
} as const satisfies Record<string, ProviderId>;

/**
 * The adapter that can verify an existing attempt. Builds any provider whose credentials exist
 * (even if no longer offered at checkout). A mismatch of `provider_mode` or `merchant_ref` is
 * refused with a CRITICAL `CONFIG_DRIFT` alert: a payment must never be verified against a
 * different terminal or account than the one it was made on.
 */
export async function providerForAttempt(
  attempt: AttemptProviderRef,
  deps: RegistryDeps & { db?: DbOrTx } = {},
): Promise<ProviderForAttempt> {
  if (attempt.provider === "OFFLINE") return { kind: "offline" };
  const providerId = ID_FROM_DB[attempt.provider];
  const provider = buildProvider(providerId, deps);
  if (!provider) return { kind: "not_configured", providerId };

  let merchantRef: string | null;
  try {
    merchantRef = provider.merchantRef();
  } catch {
    merchantRef = null;
  }
  if (
    provider.mode !== attempt.providerMode ||
    merchantRef !== attempt.merchantRef
  ) {
    const expected = {
      mode: attempt.providerMode,
      merchantRef: attempt.merchantRef,
    };
    const actual = { mode: provider.mode, merchantRef };
    log.error("payments.config_drift", { attemptId: attempt.id, providerId });
    await raiseAlert(
      {
        severity: "CRITICAL",
        kind: "CONFIG_DRIFT",
        dedupeKey: `config-drift:${providerId}:${attempt.providerMode}:${attempt.merchantRef ?? "-"}`,
        entity: "payment_attempt",
        entityId: attempt.id,
        params: {
          providerId,
          expectedMode: expected.mode,
          actualMode: actual.mode,
        },
      },
      deps.db,
    );
    return { kind: "config_drift", providerId, expected, actual };
  }
  return { kind: "ok", provider };
}
