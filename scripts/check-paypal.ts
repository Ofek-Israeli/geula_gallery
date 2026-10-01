/**
 * `npm run check:paypal` — live PayPal sandbox check (spec §4.9, §10.5). Opt-in, never in `verify`.
 * Skips cleanly (exit 0) without `PAYPAL_MODE` + client id + secret.
 *
 *   npm run check:paypal                          token → merchant id (userinfo) → create USD 1.00
 *                                                 order → print the approve URL
 *   npm run check:paypal -- --capture=<orderId>   after approving in the browser: capture → refund
 *   npm run check:paypal -- --record              write redacted fixtures to tests/fixtures/paypal
 *   npm run check:paypal -- --allow-live          permit PAYPAL_MODE=live
 */
import { randomUUID } from "node:crypto";
import type { RecordedExchange } from "@/server/integrations/http";
import {
  fail,
  flag,
  loadEnv,
  option,
  recording,
  redactUrlTokens,
  say,
  skip,
  writeFixture,
} from "./check-support";

const CHECK = "check:paypal";
const env = await loadEnv(CHECK);
if (env.PAYPAL_MODE === "disabled") skip(CHECK, "PAYPAL_MODE=disabled");
if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  skip(CHECK, "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
}
if (env.PAYPAL_MODE === "live" && !flag("allow-live")) {
  fail(CHECK, "PAYPAL_MODE=live: pass --allow-live");
}

const { createPaypalProvider, PAYPAL_BASES, paypalSummary } = await import(
  "@/server/payments/providers/paypal"
);
const { redactPaypalOrder, redactPaypalRefund } = await import(
  "@/server/payments/providers/paypal-map"
);
const { recordingFetch, isProviderError } = await import(
  "@/server/integrations/http"
);

const redactBody = (body: unknown): unknown => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.access_token === "string") {
    return { access_token: "REDACTED", expires_in: b.expires_in };
  }
  if (Array.isArray(b.purchase_units)) {
    return redactUrlTokens({
      ...(redactPaypalOrder(b) as object),
      links: b.links,
    });
  }
  if (b.status && typeof b.id === "string" && b.custom_id !== undefined) {
    return redactPaypalRefund(b);
  }
  return redactUrlTokens(b);
};

const exchanges: RecordedExchange[] = [];
const fetch = recordingFetch(
  (r: Request) => globalThis.fetch(r),
  exchanges,
  redactBody,
);
const take = () => exchanges.splice(0, exchanges.length);
const saved: string[] = [];
const record = (scenario: string, note: string) => {
  const list = take();
  if (recording()) saved.push(writeFixture("paypal", scenario, note, list));
};
const describe = (e: unknown) =>
  isProviderError(e) ? `${e.name} ${e.message}` : String(e);

say(CHECK, JSON.stringify(paypalSummary(env)));

// Merchant id (the business account's payer id): PAYPAL_MERCHANT_ID must equal it.
const base = PAYPAL_BASES[env.PAYPAL_MODE === "live" ? "live" : "sandbox"];
try {
  const tokenRes = await globalThis.fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const token = ((await tokenRes.json()) as { access_token?: string })
    .access_token;
  if (!token)
    fail(CHECK, `OAuth token request answered HTTP ${tokenRes.status}`);
  const info = await globalThis.fetch(
    `${base}/v1/identity/oauth2/userinfo?schema=paypalv1.1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const payerId = ((await info.json()) as { payer_id?: string }).payer_id;
  say(
    CHECK,
    `merchant (payer) id: ${payerId ?? `unavailable (HTTP ${info.status})`}; PAYPAL_MERCHANT_ID ${
      payerId && payerId === env.PAYPAL_MERCHANT_ID
        ? "matches"
        : "does NOT match"
    }`,
  );
} catch (error) {
  fail(CHECK, `token / userinfo failed: ${describe(error)}`);
}

const provider = createPaypalProvider({ env, fetch });
const captureId = option("capture");

if (!captureId) {
  const attemptId = randomUUID();
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const session = await provider
    .createCheckout({
      attemptId,
      attemptSeq: 1,
      orderId: randomUUID(),
      orderNumber: `GG-CHECK${Date.now().toString(36).toUpperCase()}`,
      amount: { amountMinor: 100, currency: "USD" },
      lines: [
        {
          name: "Connection check",
          amount: { amountMinor: 100, currency: "USD" },
        },
      ],
      shipping: { amountMinor: 0, currency: "USD" },
      insurance: { amountMinor: 0, currency: "USD" },
      buyer: null,
      locale: "en",
      returnUrl: `${appUrl}/api/payments/paypal/return?a=${attemptId}&l=en&s=success`,
      cancelUrl: `${appUrl}/api/payments/paypal/return?a=${attemptId}&l=en&s=cancel`,
      failUrl: `${appUrl}/api/payments/paypal/return?a=${attemptId}&l=en&s=failed`,
      notifyUrl: `${appUrl}/api/payments/paypal/webhook`,
      maxInstallments: 1,
      idemKey: randomUUID(),
    })
    .catch((e) => fail(CHECK, `create order failed: ${describe(e)}`));
  record("create-order", "POST /v2/checkout/orders (sandbox), USD 1.00.");
  const vp = await provider.fetchPayment({
    providerRef: session.providerRef,
    attemptId,
  });
  record("order-created", "GET /v2/checkout/orders/{id} before approval.");
  say(CHECK, `order ${session.providerRef} → ${vp.state}`);
  say(CHECK, `approve as the sandbox buyer: ${session.next.url}`);
  say(
    CHECK,
    `then run: npm run check:paypal -- --capture=${session.providerRef}`,
  );
} else {
  const captured = await provider.capture?.({
    providerRef: captureId,
    idemKey: randomUUID(),
  });
  record("capture", "POST /v2/checkout/orders/{id}/capture after approval.");
  if (!captured) fail(CHECK, "capture not available");
  say(
    CHECK,
    `capture → ${captured.state}, merchant ${captured.merchantRef === env.PAYPAL_MERCHANT_ID ? "matches" : "MISMATCH"}`,
  );
  if (captured.state === "succeeded" && captured.captureId && captured.amount) {
    const refund = await provider
      .refund({
        refundId: randomUUID(),
        transactionId: captured.captureId,
        captureId: captured.captureId,
        amount: captured.amount,
        isFull: true,
        idemKey: randomUUID(),
        priorRefunds: 0,
        invoiceRef: `GG-CHECK-R${Date.now().toString(36)}`,
        reason: "connection check",
      })
      .catch((e) => fail(CHECK, `refund failed: ${describe(e)}`));
    record("refund", "POST /v2/payments/captures/{id}/refund.");
    say(CHECK, `refund → ${refund.status} (${refund.providerRefundId ?? "?"})`);
  }
}

for (const file of saved) say(CHECK, `fixture written: ${file}`);
say(CHECK, "PASSED");
