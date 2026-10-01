import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach, testEnv } from "../helpers/db";
import {
  buyableArtwork,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";

/**
 * M4 cross-stream wiring of the real Cardcom adapter (WS5) with commerce (WS2) and the daily job
 * (WS6), over a fixture HTTP server (no network):
 * - gateway tax documents end to end: `launchAttempt` sends the `Document` block built by
 *   `buildGatewayDocument`, GetLpResult's `DocumentInfo` reaches `verified_raw` through
 *   `finalizeAttempt`/`apply.ts`, and the receipt job copies it (CARDCOM_GATEWAY);
 * - the live sweep runs the adapter's real `ListTransactions` (matched → finalized, unknown →
 *   CRITICAL alert);
 * - the `daily` job runs WS2's Cardcom checks (the tail poll applies a late payment).
 */
const { db } = await import("@/server/db/client");
const { adminAlerts, orders, paymentAttempts, taxDocuments } = await import(
  "@/server/db/schema"
);
const { parseEnv } = await import("@/server/env");
const { launchAttempt } = await import("@/server/checkout/start");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { createCardcomProvider } = await import(
  "@/server/payments/providers/cardcom"
);
const { setProviderFactoryForTests } = await import(
  "@/server/payments/registry"
);
const { sweepCardcomTransactions } = await import("@/server/payments/sweep");
const { issueReceiptForAttempt } = await import("@/server/taxdocs/issue");
const { taxDocumentProvider } = await import("@/server/taxdocs/registry");
const { runCronJob } = await import("@/server/jobs");
const { getSetting } = await import("@/server/settings");

cleanDatabaseBeforeEach();
afterEach(() => setProviderFactoryForTests("cardcom", null));

const LP_ID = "a1b2c3d4-0000-4000-8000-0000000000aa";
const ctx = { expired: () => false, deadline: Date.now() + 60_000 };

/** Live Cardcom with placeholder credentials and gateway tax documents (never real values). */
const liveEnv = parseEnv({
  ...testEnv(),
  DEMO_MODE: "false",
  PAYMENT_PROVIDERS: "mock,cardcom",
  CARDCOM_MODE: "live",
  CARDCOM_TERMINAL_NUMBER: "1000",
  CARDCOM_API_NAME: "test-placeholder-api-name",
  CARDCOM_API_PASSWORD: "test-placeholder-api-password",
  TAX_DOCUMENTS_MODE: "gateway",
});

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

/** A Cardcom v11 fixture server: answers by path, records every request body. */
function cardcomServer(answers: {
  lpResult?: (body: Record<string, unknown>) => unknown;
  transactions?: unknown[];
}) {
  const sent: Sent[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const text = await request.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    sent.push({ path, body });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/LowProfile/Create")) {
      return json({
        ResponseCode: 0,
        Description: "OK",
        LowProfileId: LP_ID,
        Url: `https://secure.cardcom.solutions/External/LowProfile.aspx?LowProfileCode=${LP_ID}`,
      });
    }
    if (path.endsWith("/LowProfile/GetLpResult") && answers.lpResult) {
      return json(answers.lpResult(body));
    }
    if (path.endsWith("/Transactions/ListTransactions")) {
      return json({
        ResponseCode: 0,
        Description: "OK",
        Page: body.Page,
        Page_size: body.Page_size,
        Tranzactions: body.Page === 1 ? (answers.transactions ?? []) : [],
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, sent };
}

/** A paid GetLpResult for `attemptId` (ILS, major units), optionally with a gateway document. */
function paidLpResult(
  attemptId: string,
  amountMinor: number,
  tranzactionId: number,
  doc?: { type: string; number: number; url: string },
) {
  return {
    ResponseCode: 0,
    Description: "OK",
    TerminalNumber: 1000,
    LowProfileId: LP_ID,
    TranzactionId: tranzactionId,
    ReturnValue: attemptId,
    Operation: "ChargeOnly",
    DocumentInfo: doc
      ? {
          ResponseCode: 0,
          Description: "OK",
          DocumentType: doc.type,
          DocumentNumber: doc.number,
          DocumentUrl: doc.url,
        }
      : null,
    TranzactionInfo: {
      ResponseCode: 0,
      Description: "OK",
      TranzactionId: tranzactionId,
      TerminalNumber: 1000,
      Amount: amountMinor / 100,
      CoinId: 1,
      NumberOfPayments: 1,
      Last4CardDigitsString: "4580",
      ApprovalNumber: "0012345",
      CardInfo: "Israeli",
      Brand: "Visa",
      DealType: "Debit",
    },
  };
}

/** A held order on a real (non-demo) work whose attempt is turned into a Cardcom attempt. */
async function cardcomAttempt(status: "CREATED" | "PENDING" | "EXPIRED") {
  const art = await buyableArtwork(db, { isDemo: false });
  const h = await heldOrder(art.slug);
  await execSql(
    `UPDATE payment_attempts SET provider = 'CARDCOM', provider_mode = 'LIVE',
       merchant_ref = '1000', status = $2::attempt_status, provider_ref = $3,
       redirect_url = NULL, tail_until = $4
     WHERE id = $1`,
    [
      h.attemptId,
      status,
      status === "CREATED" ? null : LP_ID,
      status === "EXPIRED" ? new Date(Date.now() + 29 * 86_400_000) : null,
    ],
  );
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, h.attemptId));
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, h.orderId));
  if (!attempt || !order) throw new Error("cardcomAttempt: rows");
  return { attempt, order };
}

describe("Cardcom gateway documents end to end (WS2 ↔ WS5)", () => {
  it("Create carries the Document; the paid result's document is stored and copied as the receipt", async () => {
    const { attempt, order } = await cardcomAttempt("CREATED");
    const server = cardcomServer({
      lpResult: () =>
        paidLpResult(attempt.id, attempt.amountMinor, 7654321, {
          type: "TaxInvoiceAndReceipt",
          number: 55012,
          url: "https://example.test/doc/55012",
        }),
    });
    const provider = createCardcomProvider({
      env: liveEnv,
      fetch: server.fetch,
    });
    setProviderFactoryForTests("cardcom", () => provider);

    const launched = await launchAttempt(attempt, order, provider, "he", {
      db,
      env: liveEnv,
    });
    expect(launched.ok).toBe(true);
    const create = server.sent.find((s) =>
      s.path.endsWith("/LowProfile/Create"),
    );
    expect(create?.body.ReturnValue).toBe(attempt.id);
    const doc = (create?.body.Document ?? {}) as Record<string, unknown>;
    const profile = await getSetting("business_profile", db);
    const patur = profile.vatMode === "OSEK_PATUR";
    expect(doc).toMatchObject({
      DocumentTypeToCreate: patur ? "Receipt" : "TaxInvoiceAndReceipt",
      Name: order.buyerName,
      IsVatFree: patur,
      ExternalId: order.number,
    });
    // The lines add up to the charged amount (major units).
    const products = (doc.Products ?? []) as { UnitCost: number }[];
    expect(products.length).toBeGreaterThan(0);
    expect(
      Math.round(products.reduce((sum, p) => sum + p.UnitCost, 0) * 100),
    ).toBe(attempt.amountMinor);

    const { result } = await finalizeAttempt(attempt.id, {
      trigger: "return",
      env: liveEnv,
    });
    expect(result.outcome).toBe("paid");
    const [paid] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id));
    expect(paid?.status).toBe("SUCCEEDED");
    expect(paid?.transactionId).toBe("7654321");
    const raw = (paid?.verifiedRaw ?? {}) as { gatewayDocument?: unknown };
    expect(raw.gatewayDocument).toEqual({
      type: "TaxInvoiceAndReceipt",
      number: "55012",
      url: "https://example.test/doc/55012",
    });

    const issued = await issueReceiptForAttempt(attempt.id, {
      provider: taxDocumentProvider({ mode: "gateway" }),
    });
    expect(issued.result.kind).toBe("issued");
    const [receipt] = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.attemptId, attempt.id));
    expect(receipt).toMatchObject({
      status: "ISSUED",
      provider: "CARDCOM_GATEWAY",
      docNumber: "55012",
      docUrl: "https://example.test/doc/55012",
    });
  });
});

describe("Cardcom daily checks (WS2 sweep ↔ WS5 adapter ↔ WS6 daily job)", () => {
  it("the live sweep lists transactions with the real adapter: matched → finalized, unknown → CRITICAL", async () => {
    const { attempt } = await cardcomAttempt("PENDING");
    const server = cardcomServer({
      lpResult: () => paidLpResult(attempt.id, attempt.amountMinor, 7654321),
      transactions: [
        {
          ResponseCode: 0,
          TranzactionId: 7654321,
          Amount: attempt.amountMinor / 100,
          CoinId: 1,
          ReturnValue: attempt.id,
          DealType: "Debit",
          IsRefund: false,
        },
        {
          ResponseCode: 0,
          TranzactionId: 9990001,
          Amount: 12.5,
          CoinId: 1,
          DealType: "Debit",
          IsRefund: false,
        },
        {
          ResponseCode: 0,
          TranzactionId: 9990002,
          Amount: 12.5,
          CoinId: 1,
          DealType: "Refund",
          IsRefund: true,
        },
      ],
    });
    const provider = createCardcomProvider({
      env: liveEnv,
      fetch: server.fetch,
    });
    setProviderFactoryForTests("cardcom", () => provider);

    const stats = await sweepCardcomTransactions(ctx, {
      db,
      env: liveEnv,
      provider,
    });
    expect(stats).toMatchObject({
      listed: 2,
      matched: 1,
      unmatched: 1,
      finalized: 1,
      outcomes: { paid: 1 },
    });
    const list = server.sent.find((s) =>
      s.path.endsWith("/Transactions/ListTransactions"),
    );
    expect(list?.body).toMatchObject({
      TranStatus: "Success",
      FromDate: expect.stringMatching(/^\d{8}$/),
    });
    const [paid] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id));
    expect(paid?.status).toBe("SUCCEEDED");
    const alerts = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "UNMATCHED_CARDCOM_TRANSACTION"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("CRITICAL");
  });

  it("the daily job runs the Cardcom tail poll: a late payment of an expired attempt is applied", async () => {
    const { attempt } = await cardcomAttempt("EXPIRED");
    const server = cardcomServer({
      lpResult: () => paidLpResult(attempt.id, attempt.amountMinor, 7654399),
    });
    setProviderFactoryForTests("cardcom", () =>
      createCardcomProvider({ env: liveEnv, fetch: server.fetch }),
    );
    const run = await runCronJob("daily", { db });
    expect(run.ok).toBe(true);
    const stats = run.stats as {
      cardcomTail?: { due: number; processed: number };
      cardcomSweep?: { skipped?: string };
    };
    expect(stats.cardcomTail).toMatchObject({ due: 1, processed: 1 });
    // The default test env is not live: the sweep is skipped, never run against the test terminal.
    expect(stats.cardcomSweep?.skipped).toBeTruthy();
    const [row] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id));
    expect(row?.lastCheckedAt).toBeInstanceOf(Date);
    expect(["SUCCEEDED", "NEEDS_REFUND"]).toContain(row?.status);
  });
});

describe("live providers and go-live blockers (WS2 ↔ WS6 golive.ts)", () => {
  it("checkout leaves out a LIVE Cardcom while go-live blockers exist", async () => {
    const { getCheckoutQuote, liveProvidersBlocked } = await import(
      "@/server/checkout/quote"
    );
    const { goLiveBlockers } = await import("@/server/golive");
    const art = await buyableArtwork(db, { isDemo: false });
    setProviderFactoryForTests("cardcom", () =>
      createCardcomProvider({ env: liveEnv }),
    );
    const report = await goLiveBlockers({ db, env: liveEnv });
    expect(report.ok).toBe(false);
    expect(await liveProvidersBlocked(db, liveEnv)).toBe(true);
    const quote = await getCheckoutQuote(
      { slug: art.slug, locale: "he", country: "IL" },
      { db, env: liveEnv },
    );
    expect(quote.kind).toBe("ok");
    if (quote.kind === "ok") {
      expect(quote.providers.map((p) => p.id)).toEqual(["mock"]);
    }
    // No LIVE provider configured: the blockers are not even read.
    expect(await liveProvidersBlocked(db)).toBe(false);
  });
});
