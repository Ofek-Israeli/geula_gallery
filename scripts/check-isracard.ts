/**
 * `npm run check:isracard` — live check against Isracard's service (PayMe) with the keys in
 * `.env.local` (`ISRACARD_MODE=test`: https://sandbox.payme.io). Opt-in, never part of `verify`.
 *
 *   npm run check:isracard                   generate-sale for ₪5 (charges nothing) → get-transactions
 *   npm run check:isracard -- --record       … and write redacted fixtures to tests/fixtures/isracard
 *   npm run check:isracard -- --allow-live   permit ISRACARD_MODE=live (creates an unpaid sale only)
 *
 * A payment needs a person: run the app with CHECKOUT_PREVIEW=true and pay on its pay page with a
 * PayMe test card (Staging: 5326105300985846, 12/30, CVV 658, ID 008336174). No card data, token
 * or buyer data is ever sent by this script, and fixtures drop the seller key and buyer details.
 */
import { randomUUID } from "node:crypto";
import type { RecordedExchange } from "@/server/integrations/http";
import {
  args,
  fail,
  flag,
  loadEnv,
  recording,
  redactUrlTokens,
  say,
  skip,
  writeFixture,
} from "./check-support";

const CHECK = "check:isracard";

const env = await loadEnv(CHECK);
if (env.ISRACARD_MODE === "disabled") {
  skip(
    CHECK,
    "ISRACARD_MODE=disabled (set ISRACARD_MODE=test with sandbox keys)",
  );
}
if (!env.ISRACARD_SELLER_ID || !env.ISRACARD_JSAPI_KEY) {
  skip(CHECK, "ISRACARD_SELLER_ID / ISRACARD_JSAPI_KEY are not set");
}
if (env.ISRACARD_MODE === "live" && !flag("allow-live")) {
  fail(
    CHECK,
    "ISRACARD_MODE=live: pass --allow-live to run against the live account",
  );
}

const { createIsracardProvider } = await import(
  "@/server/payments/providers/isracard"
);
const { hmacToken } = await import("@/server/security/tokens");
const { isProviderError, recordingFetch } = await import(
  "@/server/integrations/http"
);

const SECRET_KEYS =
  /^(seller_payme_id|payme_client_key|buyer_key|buyer_.*|.*_card_mask|payme_signature|meta_data_jwt)$/;

/** Fixture redaction: the seller key, buyer details, tokens and URL tokens. */
function redactForFixture(body: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          SECRET_KEYS.test(k) && x !== null && typeof x !== "object"
            ? "REDACTED"
            : walk(x),
        ]),
      );
    }
    if (typeof v === "string" && env.ISRACARD_SELLER_ID) {
      return v.split(env.ISRACARD_SELLER_ID).join("REDACTED");
    }
    return v;
  };
  return walk(redactUrlTokens(body));
}

const exchanges: RecordedExchange[] = [];
const fetch = recordingFetch(
  (r: Request) => globalThis.fetch(r),
  exchanges,
  redactForFixture,
);
const provider = createIsracardProvider({ env, fetch });
const take = () => exchanges.splice(0, exchanges.length);
const saved: string[] = [];
const record = (scenario: string, note: string, list: RecordedExchange[]) => {
  if (recording()) saved.push(writeFixture("isracard", scenario, note, list));
};

const attemptId = randomUUID();
const appUrl = env.APP_URL.replace(/\/+$/, "");
const ret = (s: string) =>
  `${appUrl}/api/payments/isracard/return?a=${attemptId}&r=${hmacToken("return", attemptId)}&l=he&s=${s}`;
say(
  CHECK,
  `mode ${provider.mode}${args.length ? `, args ${args.join(" ")}` : ""}`,
);

// 1. generate-sale for ₪5 (PayMe's minimum): an unpaid sale, nothing charged.
let saleId: string;
try {
  saleId = (
    await provider.hostedFields.createSale({
      attemptId,
      amount: { amountMinor: 500, currency: "ILS" },
      productName: "GG-CHECK1 · connection check",
      installments: 1,
      locale: "he",
      notifyUrl: `${env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/+$/, "")}/api/payments/isracard/webhook?a=${attemptId}&t=${hmacToken("isracard-notify", attemptId)}`,
      returnUrl: ret("success"),
      cancelUrl: ret("failed"),
    })
  ).saleId;
} catch (error) {
  record("generate-sale-rejected", "generate-sale refused.", take());
  for (const file of saved) say(CHECK, `fixture written: ${file}`);
  fail(
    CHECK,
    `generate-sale failed: ${isProviderError(error) ? `${error.name} ${error.message}` : String(error)}`,
  );
}
record(
  "generate-sale-ok",
  "generate-sale for ILS 5.00 with our attempt id as transaction_id (no buyer data).",
  take(),
);
say(CHECK, `generate-sale OK → sale ${saleId}`);

// 2. get-transactions by our transaction id: an unpaid sale is pending.
const unpaid = await provider.fetchPayment({ providerRef: saleId, attemptId });
record(
  "get-transactions-unpaid",
  "get-transactions for an unpaid sale: maps to pending.",
  take(),
);
if (unpaid.state !== "pending") {
  fail(
    CHECK,
    `get-transactions before payment mapped to ${unpaid.state}, expected pending`,
  );
}
say(CHECK, `get-transactions (unpaid) → ${unpaid.state}`);
say(
  CHECK,
  "To check a payment: CHECKOUT_PREVIEW=true, PAYMENT_PROVIDERS=isracard, then pay a work on the pay page with a PayMe test card.",
);
for (const file of saved) say(CHECK, `fixture written: ${file}`);
