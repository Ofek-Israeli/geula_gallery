/**
 * `npm run check:morning` — live Morning sandbox check (spec §4.9, §10.5). Opt-in, never in
 * `verify`. Skips cleanly (exit 0) without `MORNING_MODE` + client id + secret.
 *
 *   npm run check:morning                 token → issue a sandbox receipt (marker CHECK/…) →
 *                                         findByMarker → PDF download size
 *   npm run check:morning -- --record     write redacted fixtures to tests/fixtures/morning
 *   npm run check:morning -- --allow-live permit MORNING_MODE=live (issues a REAL document)
 */
import { randomUUID } from "node:crypto";
import type { RecordedExchange } from "@/server/integrations/http";
import {
  fail,
  flag,
  loadEnv,
  recording,
  redactUrlTokens,
  say,
  skip,
  writeFixture,
} from "./check-support";

const CHECK = "check:morning";
const env = await loadEnv(CHECK);
if (env.MORNING_MODE === "disabled") skip(CHECK, "MORNING_MODE=disabled");
if (!env.MORNING_CLIENT_ID || !env.MORNING_CLIENT_SECRET) {
  skip(CHECK, "MORNING_CLIENT_ID / MORNING_CLIENT_SECRET are not set");
}
if (env.MORNING_MODE === "live" && !flag("allow-live")) {
  fail(CHECK, "MORNING_MODE=live issues real tax documents: pass --allow-live");
}

const { createMorningTaxDocumentProvider, morningBases } = await import(
  "@/server/taxdocs/morning"
);
const { recordingFetch, isProviderError } = await import(
  "@/server/integrations/http"
);

const SENSITIVE =
  /^(accessToken|client_secret|client_id|emails?|phone|mobile|taxId|address)$/i;
const redactBody = (body: unknown): unknown => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          SENSITIVE.test(k) ? "REDACTED" : walk(x),
        ]),
      );
    }
    return v;
  };
  return walk(redactUrlTokens(body));
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
  if (recording()) saved.push(writeFixture("morning", scenario, note, list));
};
const describe = (e: unknown) =>
  isProviderError(e) ? `${e.name} ${e.message}` : String(e);

say(CHECK, `mode ${env.MORNING_MODE}, api ${morningBases(env).api}`);
const provider = createMorningTaxDocumentProvider({ env, fetch });
const marker = `GG-CHECK/RECEIPT/${randomUUID().slice(0, 8)}`;
const today = new Date().toISOString().slice(0, 10);

const doc = await provider
  .issueReceipt({
    marker,
    orderNumber: "GG-CHECK1",
    vatMode: "OSEK_PATUR",
    zeroRatedExport: false,
    language: "he",
    currency: "ILS",
    client: { name: "Sandbox check", country: "IL" },
    lines: [{ description: "בדיקת חיבור", unitPriceMinor: 100, quantity: 1 }],
    payment: {
      type: "transfer",
      amountMinor: 100,
      date: today,
      reference: "CHECK",
    },
  })
  .catch((e) => fail(CHECK, `issue receipt failed: ${describe(e)}`));
record("issue-receipt", "Token + POST /documents (type 400, sandbox).");
say(CHECK, `receipt ${doc.docNumber} (type ${doc.docTypeCode}) issued`);

const found = await provider.findByMarker?.(marker, new Date());
record("find-by-marker", "POST /documents/search by description (marker).");
say(
  CHECK,
  `findByMarker → ${found ? `found ${found.docNumber}` : "NOT FOUND"}`,
);
if (!found || found.providerDocId !== doc.providerDocId) {
  fail(CHECK, "the marker search did not return the issued document");
}

const pdf = await provider.getPdf?.(doc.providerDocId);
take();
say(CHECK, `PDF ${pdf ? `${pdf.byteLength} bytes` : "unavailable"}`);

for (const file of saved) say(CHECK, `fixture written: ${file}`);
say(CHECK, "PASSED");
