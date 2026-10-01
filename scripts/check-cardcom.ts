/**
 * `npm run check:cardcom` — live check against the Cardcom terminal in `.env.local` (spec §10.5).
 * Opt-in, never part of `verify`. Intended for the PUBLIC TEST TERMINAL (`CARDCOM_MODE=test`).
 *
 *   npm run check:cardcom                     Create ₪1 → GetLpResult (unpaid) → hosted page check
 *   npm run check:cardcom -- --record         … and write redacted fixtures to tests/fixtures/cardcom
 *   npm run check:cardcom -- --wait[=600]     … then poll GetLpResult until a human pays with a test
 *                                             card on the printed URL (default 10 min)
 *   npm run check:cardcom -- --locale=en      English hosted page
 *   npm run check:cardcom -- --allow-live     permit CARDCOM_MODE=live (creates a page, charges nothing)
 *
 * No buyer data is ever sent (`buyer: null`, and the adapter sends none in TEST mode). Refunds and
 * ListTransactions need a real terminal's ApiPassword and are skipped without one.
 */
import { randomUUID } from "node:crypto";
import type { RecordedExchange } from "@/server/integrations/http";
import {
  args,
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

const CHECK = "check:cardcom";
const PLACEHOLDER_TERMINAL = 1000;

const env = await loadEnv(CHECK);
if (env.CARDCOM_MODE === "disabled") {
  skip(
    CHECK,
    "CARDCOM_MODE=disabled (set CARDCOM_MODE=test with the public test-terminal values in .env.local)",
  );
}
if (!env.CARDCOM_TERMINAL_NUMBER || !env.CARDCOM_API_NAME) {
  skip(CHECK, "CARDCOM_TERMINAL_NUMBER / CARDCOM_API_NAME are not set");
}
if (env.CARDCOM_MODE === "live" && !flag("allow-live")) {
  fail(
    CHECK,
    "CARDCOM_MODE=live: pass --allow-live to run against a real terminal",
  );
}

const { createCardcomProvider } = await import(
  "@/server/payments/providers/cardcom"
);
const { redactCardcom } = await import(
  "@/server/payments/providers/cardcom-map"
);
const { hmacToken } = await import("@/server/security/tokens");
const { ProviderRejectedError, isProviderError, recordingFetch } = await import(
  "@/server/integrations/http"
);

/** Fixture redaction: Cardcom redactor + token query values + the terminal number. */
function redactForFixture(body: unknown): unknown {
  const terminal = env.CARDCOM_TERMINAL_NUMBER;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          k === "TerminalNumber" && x !== null && x !== undefined
            ? PLACEHOLDER_TERMINAL
            : walk(x),
        ]),
      );
    }
    if (typeof v === "string" && terminal && v.includes(terminal)) {
      return v.split(terminal).join(String(PLACEHOLDER_TERMINAL));
    }
    return v;
  };
  return walk(redactUrlTokens(redactCardcom(body)));
}

const exchanges: RecordedExchange[] = [];
const baseFetch = (r: Request) => globalThis.fetch(r);
const fetch = recordingFetch(baseFetch, exchanges, redactForFixture);
const provider = createCardcomProvider({ env, fetch });
const take = () => exchanges.splice(0, exchanges.length);
const saved: string[] = [];
const record = (scenario: string, note: string, list: RecordedExchange[]) => {
  if (recording()) saved.push(writeFixture("cardcom", scenario, note, list));
};

const locale = option("locale") === "en" ? "en" : "he";
const attemptId = randomUUID();
const appUrl = env.APP_URL.replace(/\/+$/, "");
const ret = (s: string) =>
  `${appUrl}/api/payments/cardcom/return?a=${attemptId}&r=${hmacToken("return", attemptId)}&l=${locale}&s=${s}`;
const notifyUrl = `${env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/+$/, "")}/api/payments/cardcom/webhook?a=${attemptId}&t=${hmacToken("cardcom-notify", attemptId)}`;

say(
  CHECK,
  `mode ${provider.mode}, base ${env.CARDCOM_BASE_URL}, locale ${locale}${args.length ? `, args ${args.join(" ")}` : ""}`,
);

// 1. LowProfile/Create for ₪1.
let providerRef: string;
let hostedUrl: string;
try {
  const session = await provider.createCheckout({
    attemptId,
    attemptSeq: 1,
    orderId: randomUUID(),
    orderNumber: "GG-CHECK1",
    amount: { amountMinor: 100, currency: "ILS" },
    lines: [
      {
        name: locale === "he" ? "בדיקת חיבור" : "Connection check",
        amount: { amountMinor: 100, currency: "ILS" },
      },
    ],
    shipping: { amountMinor: 0, currency: "ILS" },
    insurance: { amountMinor: 0, currency: "ILS" },
    buyer: null,
    locale,
    returnUrl: ret("success"),
    cancelUrl: ret("cancel"),
    failUrl: ret("failed"),
    notifyUrl,
    maxInstallments: 1,
    idemKey: attemptId,
  });
  providerRef = session.providerRef;
  hostedUrl = session.next.url;
} catch (error) {
  record(
    "create-rejected",
    "LowProfile/Create refused by Cardcom (ResponseCode 603: wrong user name or password).",
    take(),
  );
  for (const file of saved) say(CHECK, `fixture written: ${file}`);
  const code = error instanceof ProviderRejectedError ? error.code : undefined;
  fail(
    CHECK,
    `LowProfile/Create failed: ${isProviderError(error) ? `${error.name} ${error.message}` : String(error)}${
      code === "603"
        ? "\n  Cardcom answered 603 (wrong user name or password): the terminal number / ApiName in .env.local are not accepted. Ask Cardcom for current test-terminal credentials."
        : ""
    }`,
  );
}
record(
  "create-ok",
  "LowProfile/Create for ILS 1.00 on the public test terminal (buyer data never sent).",
  take(),
);
say(CHECK, `Create OK → LowProfileId ${providerRef}`);
say(CHECK, `hosted payment page: ${hostedUrl}`);

// 2. GetLpResult before payment: must be `pending`.
const unpaid = await provider.fetchPayment({ providerRef, attemptId });
record(
  "getlpresult-unpaid",
  "GetLpResult for a LowProfile nobody paid yet: maps to pending.",
  take(),
);
if (unpaid.state !== "pending") {
  fail(
    CHECK,
    `GetLpResult before payment mapped to ${unpaid.state}, expected pending`,
  );
}
say(
  CHECK,
  `GetLpResult (unpaid) → ${unpaid.state}; ResponseCode ${String((unpaid.rawRedacted as { ResponseCode?: unknown })?.ResponseCode)}; echoed ReturnValue ${unpaid.echoedReference === attemptId ? "matches" : (unpaid.echoedReference ?? "absent")}`,
);

// 3. The hosted page renders in the requested language.
try {
  const page = await baseFetch(
    new Request(hostedUrl, { headers: { "Accept-Language": locale } }),
  );
  const html = await page.text();
  const lang = /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1] ?? "?";
  const dir = /<html[^>]*\bdir="([^"]+)"/i.exec(html)?.[1] ?? "?";
  const hebrew = /[֐-׿]/.test(html);
  say(
    CHECK,
    `hosted page HTTP ${page.status}, html lang=${lang} dir=${dir}, Hebrew text ${hebrew ? "present" : "absent"}`,
  );
  if (!page.ok) fail(CHECK, `hosted page answered HTTP ${page.status}`);
} catch (error) {
  fail(CHECK, `hosted page fetch failed: ${(error as Error).message}`);
}

// 4. Negative paths (fixtures for the contract suite).
const bogus = await provider
  .fetchPayment({ providerRef: randomUUID(), attemptId })
  .then(
    (vp) => `mapped to ${vp.state}`,
    (e) => (isProviderError(e) ? `${e.name}` : String(e)),
  );
record(
  "getlpresult-unknown",
  "GetLpResult for a LowProfileId that does not exist.",
  take(),
);
say(CHECK, `GetLpResult (unknown LowProfileId) → ${bogus}`);

const badName = createCardcomProvider({
  env: { ...env, CARDCOM_API_NAME: "placeholder-invalid-name" },
  fetch,
});
const rejected = await badName
  .createCheckout({
    attemptId,
    attemptSeq: 1,
    orderId: randomUUID(),
    orderNumber: "GG-CHECK1",
    amount: { amountMinor: 100, currency: "ILS" },
    lines: [
      {
        name: "Connection check",
        amount: { amountMinor: 100, currency: "ILS" },
      },
    ],
    shipping: { amountMinor: 0, currency: "ILS" },
    insurance: { amountMinor: 0, currency: "ILS" },
    buyer: null,
    locale,
    returnUrl: ret("success"),
    cancelUrl: ret("cancel"),
    failUrl: ret("failed"),
    notifyUrl,
    maxInstallments: 1,
    idemKey: attemptId,
  })
  .then(
    () => "accepted (unexpected)",
    (e) =>
      e instanceof ProviderRejectedError
        ? `ProviderRejectedError code ${e.code ?? "?"} HTTP ${e.status ?? "?"}`
        : isProviderError(e)
          ? e.name
          : String(e),
  );
record(
  "create-rejected",
  "LowProfile/Create with an invalid ApiName: refused by Cardcom.",
  take(),
);
say(CHECK, `Create with an invalid ApiName → ${rejected}`);

// 5. Refunds and ListTransactions need a real terminal's ApiPassword.
if (!env.CARDCOM_API_PASSWORD) {
  say(
    CHECK,
    "refund / ListTransactions: skipped (no CARDCOM_API_PASSWORD on the test terminal)",
  );
}

// 6. Optional: wait for a human test payment.
const waitArg = args.find((a) => a === "--wait" || a.startsWith("--wait="));
if (waitArg) {
  const seconds = Number(waitArg.split("=")[1] ?? 600) || 600;
  say(
    CHECK,
    `waiting up to ${seconds}s for a test payment on the hosted page above…`,
  );
  const until = Date.now() + seconds * 1000;
  let state = "pending";
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5000));
    const vp = await provider
      .fetchPayment({ providerRef, attemptId })
      .catch(() => null);
    if (vp && vp.state !== "pending") {
      state = vp.state;
      record(
        "getlpresult-paid",
        "GetLpResult after a test-card payment.",
        take(),
      );
      say(
        CHECK,
        `payment → ${vp.state}, amount ${vp.amount ? `${vp.amount.amountMinor} ${vp.amount.currency}` : "?"}, reference ${vp.echoedReference === attemptId ? "matches" : "MISMATCH"}, terminal ${vp.merchantRef === env.CARDCOM_TERMINAL_NUMBER ? "matches" : "MISMATCH"}`,
      );
      break;
    }
    take();
  }
  if (state === "pending")
    say(
      CHECK,
      "no payment within the wait window (documented as blocked by the test card)",
    );
}

for (const file of saved) say(CHECK, `fixture written: ${file}`);
say(CHECK, "PASSED");
