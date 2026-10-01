import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/server/db/client";
import { type MockPayment, mockPayments } from "@/server/db/schema";
import type { MockPaymentState } from "@/server/db/schema/enums";
import {
  ProviderRejectedError,
  ProviderTimeoutError,
} from "@/server/integrations/http";
import { log } from "@/server/log";
import { hmacHex, safeEqual } from "@/server/security/crypto";
import type {
  PaymentProvider,
  ProviderFactoryInput,
  VerifiedPayment,
  VerifiedState,
} from "../types";

/**
 * The mock provider (spec §4.2 `mock`): a hosted page at `/[locale]/mock-pay/[ref]` backed by the
 * `mock_payments` table, HMAC-signed webhooks (`x-mock-signature: t=<unix>,v1=<hex>` over
 * `t + "." + rawBody`, 300 s tolerance), DIRECT and CAPTURE flows, and capture/refund calls that
 * are idempotent per request id. Non-production only (or demo items in a demo deployment; the
 * registry decides).
 *
 * Tests steer failure modes through `mockProviderHooks` (never active in production).
 */
export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

/** The app database, loaded lazily so the constants here import without an environment. */
async function appDb(): Promise<DbOrTx> {
  return (await import("@/server/db/client")).db;
}
export const MOCK_SIGNATURE_TOLERANCE_SEC = 300;
export const MOCK_MERCHANT_REF = "mock-merchant";
/** Watch window for a pending mock attempt (spec §5.2 step 6: mock 1 h). */
export const MOCK_WATCH_HOURS = 1;

export type MockFlow = "DIRECT" | "CAPTURE";

/** One-shot failure injection for tests (spec §10.3). Each flag is consumed by the next call. */
export interface MockProviderHooks {
  /** The next `capture` throws a timeout; `applied` = the capture happened before the "timeout". */
  captureTimeout: null | { applied: boolean };
  /** The next `capture` puts the payment under review instead of paying it. */
  captureReview: boolean;
  /** The next `refund` throws a timeout; `applied` = the refund happened first. */
  refundTimeout: null | { applied: boolean };
  /** The next `refund` is rejected (a clear non-zero result, like Cardcom's). */
  refundReject: boolean;
  /** The next `refund` is accepted as pending at the provider. */
  refundPending: boolean;
  /** The next `fetchPayment` throws a timeout. */
  fetchTimeout: boolean;
  /** Counts calls (assertions such as "no second refund call"). */
  calls: { capture: number; refund: number; fetch: number; getRefund: number };
  /** Forces the flow of the next `createCheckout`. */
  nextFlow: MockFlow | null;
}

function freshHooks(): MockProviderHooks {
  return {
    captureTimeout: null,
    captureReview: false,
    refundTimeout: null,
    refundReject: false,
    refundPending: false,
    fetchTimeout: false,
    calls: { capture: 0, refund: 0, fetch: 0, getRefund: 0 },
    nextFlow: null,
  };
}

export const mockProviderHooks: MockProviderHooks = freshHooks();

export function resetMockProviderHooks(): void {
  Object.assign(mockProviderHooks, freshHooks());
}

const STATE_MAP: Record<MockPaymentState, VerifiedState> = {
  OPEN: "pending",
  APPROVED: "requires_capture",
  PAID: "succeeded",
  REVIEW: "review",
  DECLINED: "failed",
  CANCELED: "canceled",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
};

/** Money moved (or is held) at the provider in these states. */
const MONEY_STATES = new Set<MockPaymentState>([
  "APPROVED",
  "PAID",
  "REVIEW",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

export function verifiedFromMock(row: MockPayment): VerifiedPayment {
  return {
    state: STATE_MAP[row.state],
    amount: MONEY_STATES.has(row.state)
      ? { amountMinor: row.amountMinor, currency: row.currency }
      : null,
    echoedReference: row.attemptId,
    merchantRef: MOCK_MERCHANT_REF,
    ...(row.transactionId ? { transactionId: row.transactionId } : {}),
    ...(row.transactionId && row.flow === "CAPTURE"
      ? { captureId: row.transactionId }
      : {}),
    ...(MONEY_STATES.has(row.state)
      ? { method: "card", last4: "4242", brand: "MOCK", installments: 1 }
      : {}),
    ...(row.refundedMinor > 0 ? { refundedMinor: row.refundedMinor } : {}),
    rawRedacted: {
      ref: row.ref,
      state: row.state,
      flow: row.flow,
      amountMinor: row.amountMinor,
      currency: row.currency,
      refundedMinor: row.refundedMinor,
    },
  };
}

async function loadByRef(
  ref: string,
  dbOrNull?: DbOrTx,
): Promise<MockPayment | null> {
  const db = dbOrNull ?? (await appDb());
  const [row] = await db
    .select()
    .from(mockPayments)
    .where(eq(mockPayments.ref, ref))
    .limit(1);
  return row ?? null;
}

export function getMockPayment(ref: string): Promise<MockPayment | null> {
  return loadByRef(ref);
}

function newTransactionId(): string {
  return `mocktx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`. */
export function signMockPayload(
  rawBody: string,
  secret: string,
  t: number,
): string {
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** Pure check of a signature header against the secret, with the 300 s tolerance. */
export function verifyMockSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isInteger(t) || !v1) return false;
  if (Math.abs(nowSec - t) > MOCK_SIGNATURE_TOLERANCE_SEC) return false;
  return safeEqual(hmacHex(secret, `${t}.${rawBody}`), v1);
}

export function createMockProvider(
  input: ProviderFactoryInput,
): PaymentProvider {
  const { env } = input;
  const testHooks = !env.isProduction;
  const hooks = mockProviderHooks;

  return {
    id: "mock",
    mode: "MOCK",
    capabilities: {
      currencies: ["ILS", "USD"],
      wallets: [],
      installments: false,
      notificationAuth: "signature",
      requiresCapture: false,
      refunds: "api",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },
    merchantRef: () => MOCK_MERCHANT_REF,

    async authenticateNotification(n) {
      return verifyMockSignature(
        n.headers.get(MOCK_SIGNATURE_HEADER),
        n.rawBody,
        env.MOCK_WEBHOOK_SECRET,
      );
    },

    parseNotification(n) {
      let body: { id?: unknown; type?: unknown; ref?: unknown } = {};
      try {
        body = JSON.parse(n.rawBody) as typeof body;
      } catch {
        body = {};
      }
      const id = typeof body.id === "string" ? body.id.slice(0, 100) : "";
      const ref = typeof body.ref === "string" ? body.ref.slice(0, 100) : "";
      const type = typeof body.type === "string" ? body.type.slice(0, 60) : "";
      return {
        eventKey: id || `mock:${ref}:${n.rawBody.length}`,
        ...(type ? { eventType: type } : {}),
        ...(ref ? { providerRef: ref } : {}),
        payloadRedacted: { id, type, ref },
      };
    },

    async createCheckout(i) {
      const flow: MockFlow =
        (testHooks ? hooks.nextFlow : null) ??
        (env.MOCK_PAYMENT_FLOW === "capture" ? "CAPTURE" : "DIRECT");
      hooks.nextFlow = null;
      const ref = `mock_${randomUUID().replace(/-/g, "")}`;
      await (await appDb()).insert(mockPayments).values({
        ref,
        attemptId: i.attemptId,
        amountMinor: i.amount.amountMinor,
        currency: i.amount.currency,
        flow,
        state: "OPEN",
        returnUrl: i.returnUrl,
        cancelUrl: i.cancelUrl,
        notifyUrl: i.notifyUrl,
      });
      const url = `${env.APP_URL}/${i.locale}/mock-pay/${encodeURIComponent(ref)}`;
      return { providerRef: ref, next: { kind: "redirect", url } };
    },

    async fetchPayment(r) {
      hooks.calls.fetch += 1;
      if (testHooks && hooks.fetchTimeout) {
        hooks.fetchTimeout = false;
        throw new ProviderTimeoutError("mock", "fetchPayment timed out (hook)");
      }
      const row = await loadByRef(r.providerRef);
      if (!row) {
        throw new ProviderRejectedError("mock", "unknown mock payment", 404);
      }
      return verifiedFromMock(row);
    },

    async capture(r) {
      hooks.calls.capture += 1;
      const timeout = testHooks ? hooks.captureTimeout : null;
      hooks.captureTimeout = null;
      const review = testHooks && hooks.captureReview;
      hooks.captureReview = false;
      if (timeout && !timeout.applied) {
        throw new ProviderTimeoutError("mock", "capture timed out (hook)");
      }
      const row = await loadByRef(r.providerRef);
      if (!row) {
        throw new ProviderRejectedError("mock", "unknown mock payment", 404);
      }
      let current = row;
      // Idempotent per request id: a repeated key returns the current state.
      if (!row.captureRequestIds.includes(r.idemKey)) {
        if (row.state !== "APPROVED") {
          throw new ProviderRejectedError(
            "mock",
            `cannot capture a ${row.state} payment`,
            422,
          );
        }
        const [updated] = await (await appDb())
          .update(mockPayments)
          .set({
            state: review ? "REVIEW" : "PAID",
            transactionId: row.transactionId ?? newTransactionId(),
            captureRequestIds: sql`array_append(${mockPayments.captureRequestIds}, ${r.idemKey})`,
          })
          .where(
            and(
              eq(mockPayments.id, row.id),
              eq(mockPayments.state, "APPROVED"),
            ),
          )
          .returning();
        current = updated ?? ((await loadByRef(r.providerRef)) as MockPayment);
      }
      if (timeout?.applied) {
        throw new ProviderTimeoutError("mock", "capture response lost (hook)");
      }
      return verifiedFromMock(current);
    },

    async refund(i) {
      hooks.calls.refund += 1;
      const requestId = `${i.refundId}/${i.idemKey}`;
      if (testHooks && hooks.refundReject) {
        hooks.refundReject = false;
        throw new ProviderRejectedError(
          "mock",
          "refund declined (hook)",
          400,
          "620",
        );
      }
      const timeout = testHooks ? hooks.refundTimeout : null;
      hooks.refundTimeout = null;
      if (timeout && !timeout.applied) {
        throw new ProviderTimeoutError("mock", "refund timed out (hook)");
      }
      const pending = testHooks && hooks.refundPending;
      hooks.refundPending = false;

      const [row] = await (await appDb())
        .select()
        .from(mockPayments)
        .where(eq(mockPayments.transactionId, i.transactionId))
        .limit(1);
      if (!row) {
        throw new ProviderRejectedError("mock", "unknown transaction", 404);
      }
      if (!row.refundRequestIds.includes(requestId)) {
        const refunded = row.refundedMinor + i.amount.amountMinor;
        if (refunded > row.amountMinor) {
          throw new ProviderRejectedError(
            "mock",
            "refund exceeds the payment",
            422,
          );
        }
        await (await appDb())
          .update(mockPayments)
          .set({
            refundedMinor: refunded,
            state:
              refunded === row.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED",
            refundRequestIds: sql`array_append(${mockPayments.refundRequestIds}, ${requestId})`,
          })
          .where(eq(mockPayments.id, row.id));
      }
      if (timeout?.applied) {
        throw new ProviderTimeoutError("mock", "refund response lost (hook)");
      }
      return {
        status: pending ? "pending" : "succeeded",
        providerRefundId: `mockrf_${i.idemKey}`,
        rawRedacted: { requestId, pending },
      };
    },

    async getRefund(r) {
      hooks.calls.getRefund += 1;
      const prefix = `${r.refundId}/`;
      const rows = await (await appDb())
        .select({ ids: mockPayments.refundRequestIds })
        .from(mockPayments)
        .where(
          sql`EXISTS (SELECT 1 FROM unnest(${mockPayments.refundRequestIds}) x WHERE x LIKE ${`${prefix}%`})`,
        )
        .limit(1);
      const id = rows[0]?.ids.find((x) => x.startsWith(prefix));
      if (!id) return { status: "not_found" };
      return {
        status: "succeeded",
        providerRefundId: `mockrf_${id.slice(prefix.length)}`,
      };
    },
  };
}

// ---------------------------------------------------------------- hosted page (mock-pay)

export type MockPageAction =
  | "pay"
  | "approve"
  | "review"
  | "decline"
  | "cancel"
  | "pay_no_return";

export interface MockPageResult {
  /** Where the buyer goes next; null for "Pay without returning". */
  redirectTo: string | null;
  state: MockPaymentState;
}

/**
 * The six buttons of the hosted page (spec §4.2): Pay, Approve only, Mark under review, Decline,
 * Cancel, Pay without returning. Only an OPEN payment changes; a repeated click is a no-op that
 * returns the same destination. In the CAPTURE flow "Pay" only approves (the shop captures).
 */
export async function applyMockPageAction(
  ref: string,
  action: MockPageAction,
  opts: { db?: DbOrTx; notify?: (row: MockPayment) => Promise<void> } = {},
): Promise<MockPageResult | null> {
  const db = opts.db ?? (await appDb());
  const row = await loadByRef(ref, db);
  if (!row) return null;
  let next: MockPaymentState | null = null;
  switch (action) {
    case "pay":
    case "pay_no_return":
      next = row.flow === "CAPTURE" ? "APPROVED" : "PAID";
      break;
    case "approve":
      next = "APPROVED";
      break;
    case "review":
      next = "REVIEW";
      break;
    case "decline":
      next = "DECLINED";
      break;
    case "cancel":
      next = "CANCELED";
      break;
  }
  let current = row;
  if (row.state === "OPEN") {
    const [updated] = await db
      .update(mockPayments)
      .set({
        state: next,
        ...(next === "PAID" || next === "REVIEW"
          ? { transactionId: newTransactionId() }
          : {}),
      })
      .where(and(eq(mockPayments.id, row.id), eq(mockPayments.state, "OPEN")))
      .returning();
    if (updated) {
      current = updated;
      await (opts.notify ?? sendMockWebhook)(updated).catch((error) => {
        log.warn("mock.webhook_send_failed", { ref }, error);
      });
    } else {
      current = (await loadByRef(ref, db)) ?? row;
    }
  }
  const redirectTo =
    action === "pay_no_return"
      ? null
      : current.state === "CANCELED"
        ? current.cancelUrl
        : current.returnUrl;
  return { redirectTo, state: current.state };
}

/** Test/admin helper: resolve a mock payment under review (PayPal PENDING → COMPLETED/DENIED). */
export async function resolveMockReview(
  ref: string,
  outcome: "PAID" | "DECLINED",
  dbOrNull?: DbOrTx,
): Promise<void> {
  const db = dbOrNull ?? (await appDb());
  await db
    .update(mockPayments)
    .set({ state: outcome })
    .where(and(eq(mockPayments.ref, ref), eq(mockPayments.state, "REVIEW")));
}

/**
 * The mock webhook: a real HTTP POST to `notify_url` with
 * `{"id":"evt_<uuid>","type":"payment.updated","ref":"<ref>"}`, signed with `MOCK_WEBHOOK_SECRET`.
 * Best effort (3 s timeout); a lost webhook is the normal localhost case and the return route,
 * reconcile and Recheck still finalize the payment (spec §5.3 #3).
 */
export async function sendMockWebhook(row: MockPayment): Promise<void> {
  const { env } = await import("@/server/env");
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: "payment.updated",
    ref: row.ref,
  });
  const t = Math.floor(Date.now() / 1000);
  await fetch(row.notifyUrl, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      [MOCK_SIGNATURE_HEADER]: signMockPayload(
        body,
        env.MOCK_WEBHOOK_SECRET,
        t,
      ),
    },
    signal: AbortSignal.timeout(3000),
  });
}
