/**
 * Shared payment-provider contract suite (spec §10.2). Each adapter test file supplies a harness
 * that builds the adapter on a fixture-replaying fetch; the suite checks what every provider must
 * honour: identity and capabilities, redirect extraction, every declared state mapped from its
 * fixture, minor units, verification fields on money states, notification authentication (good
 * accepted, bad rejected), event keys without PII, refund result shapes and the
 * ProviderNotConfigured path.
 */
import { describe, expect, it } from "vitest";
import { CURRENCIES } from "@/lib/money";
import { ProviderNotConfiguredError } from "@/server/integrations/http";
import type {
  CreateCheckoutInput,
  IncomingNotification,
  PaymentProvider,
  RefundInput,
  VerifiedState,
} from "@/server/payments/types";
import type { ReplayRoute, SentRequest } from "./support/replay";

export const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

export interface StateCase {
  fixture: string;
  expected: VerifiedState;
}

export interface PaymentProviderHarness {
  name: string;
  build(
    routes: ReplayRoute[],
  ): Promise<{ provider: PaymentProvider; sent: SentRequest[] }>;
  /** The same adapter without credentials. */
  buildUnconfigured(): Promise<PaymentProvider>;
  routes(fixture: string): ReplayRoute[];
  /** Routes every authenticated call needs first (e.g. an OAuth token), or []. */
  authRoutes: ReplayRoute[];
  checkout: CreateCheckoutInput;
  createFixture: string;
  providerRef: string;
  merchantRef: string;
  states: StateCase[];
  notification: {
    good(): { n: IncomingNotification & { ip: string }; routes: ReplayRoute[] };
    bad(): { n: IncomingNotification & { ip: string }; routes: ReplayRoute[] };
  };
  refund: { input: RefundInput; fixture: string; expected: string }[];
  /** Strings that must never appear in stored payloads (buyer PII, card data). */
  pii: string[];
}

const MONEY_STATES = new Set<VerifiedState>([
  "requires_capture",
  "review",
  "succeeded",
  "refunded",
  "partially_refunded",
]);

export function paymentProviderContract(h: PaymentProviderHarness): void {
  describe(`payment provider contract: ${h.name}`, () => {
    it("has a valid identity and capabilities", async () => {
      const { provider } = await h.build([]);
      expect(["mock", "cardcom", "paypal"]).toContain(provider.id);
      expect(["MOCK", "TEST", "LIVE"]).toContain(provider.mode);
      expect(provider.capabilities.currencies.length).toBeGreaterThan(0);
      for (const c of provider.capabilities.currencies) {
        expect(CURRENCIES).toContain(c);
      }
      expect(provider.merchantRef()).toBe(h.merchantRef);
    });

    it("creates a checkout and extracts an absolute https redirect", async () => {
      const { provider } = await h.build([
        ...h.authRoutes,
        ...h.routes(h.createFixture),
      ]);
      const session = await provider.createCheckout(h.checkout);
      expect(session.providerRef).toBe(h.providerRef);
      expect(session.next.kind).toBe("redirect");
      expect(new URL(session.next.url).protocol).toBe("https:");
    });

    for (const c of h.states) {
      it(`maps ${c.fixture} to ${c.expected}`, async () => {
        const { provider } = await h.build([
          ...h.authRoutes,
          ...h.routes(c.fixture),
        ]);
        const vp = await provider.fetchPayment({
          providerRef: h.providerRef,
          attemptId: ATTEMPT_ID,
        });
        expect(vp.state).toBe(c.expected);
        if (vp.amount) {
          expect(Number.isSafeInteger(vp.amount.amountMinor)).toBe(true);
          expect(vp.amount.amountMinor).toBeGreaterThanOrEqual(0);
          expect(CURRENCIES).toContain(vp.amount.currency);
        }
        if (MONEY_STATES.has(vp.state)) {
          expect(vp.amount).not.toBeNull();
          expect(vp.echoedReference).toBe(ATTEMPT_ID);
          expect(vp.merchantRef).toBe(h.merchantRef);
        }
        const stored = JSON.stringify(vp.rawRedacted);
        for (const s of h.pii) expect(stored).not.toContain(s);
      });
    }

    it("authenticates a genuine notification and rejects a forged one", async () => {
      const good = h.notification.good();
      const okProvider = (await h.build(good.routes)).provider;
      expect(await okProvider.authenticateNotification(good.n)).toBe(true);
      const parsed = okProvider.parseNotification(good.n);
      expect(parsed.eventKey).toMatch(/\S/);
      const stored = JSON.stringify(parsed.payloadRedacted);
      for (const s of h.pii) expect(stored).not.toContain(s);

      const bad = h.notification.bad();
      const badProvider = (await h.build(bad.routes)).provider;
      expect(await badProvider.authenticateNotification(bad.n)).toBe(false);
    });

    for (const r of h.refund) {
      it(`refund (${r.fixture}) → ${r.expected}`, async () => {
        const { provider } = await h.build([
          ...h.authRoutes,
          ...(r.fixture ? h.routes(r.fixture) : []),
        ]);
        const out = await provider.refund(r.input).then(
          (x) => x.status,
          (e: Error) => e.name,
        );
        expect(out).toBe(r.expected);
      });
    }

    it("throws ProviderNotConfiguredError without credentials", async () => {
      const provider = await h.buildUnconfigured();
      await expect(provider.createCheckout(h.checkout)).rejects.toBeInstanceOf(
        ProviderNotConfiguredError,
      );
      await expect(
        provider.fetchPayment({
          providerRef: h.providerRef,
          attemptId: ATTEMPT_ID,
        }),
      ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    });
  });
}

export function checkoutInput(
  overrides: Partial<CreateCheckoutInput> = {},
): CreateCheckoutInput {
  const base = "https://gallery.example.com";
  return {
    attemptId: ATTEMPT_ID,
    attemptSeq: 1,
    orderId: "33333333-3333-4333-8333-333333333333",
    orderNumber: "GG-7K3M9Q",
    amount: { amountMinor: 125_050, currency: "ILS" },
    lines: [
      { name: "Moonrise", amount: { amountMinor: 120_000, currency: "ILS" } },
    ],
    shipping: { amountMinor: 4_050, currency: "ILS" },
    insurance: { amountMinor: 1_000, currency: "ILS" },
    buyer: {
      name: "Test Buyer",
      email: "buyer@example.com",
      phone: "03-000-0000",
    },
    locale: "he",
    returnUrl: `${base}/api/payments/x/return?s=success`,
    cancelUrl: `${base}/api/payments/x/return?s=cancel`,
    failUrl: `${base}/api/payments/x/return?s=failed`,
    notifyUrl: `${base}/api/payments/x/webhook`,
    maxInstallments: 1,
    idemKey: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}
