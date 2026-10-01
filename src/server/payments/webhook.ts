import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { isLocale, type Locale } from "@/lib/locale";
import { fromDecimal, isCurrency } from "@/lib/money";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { raiseAlert } from "@/server/alerts/service";
import { orderUrlFor } from "@/server/checkout/start";
import { type Db, db as defaultDb } from "@/server/db/client";
import {
  orders,
  type PaymentEvent,
  paymentAttempts,
  paymentEvents,
  refunds,
} from "@/server/db/schema";
import {
  type Effects,
  mergeEffects,
  NO_EFFECTS,
} from "@/server/domain/effects";
import { env as defaultEnv, type Env } from "@/server/env";
import { log } from "@/server/log";
import { checkLimit } from "@/server/security/rate-limit";
import { verifyHmacToken } from "@/server/security/tokens";
import { type FinalizeOutcome, finalizeAttempt } from "./finalize";
import { type PostSuccessEvent, syncPostSuccessEvent } from "./post-success";
import { buildProvider } from "./registry";
import { PROVIDER_DB_VALUE, PROVIDER_IDS, type ProviderId } from "./types";

/**
 * Payment notifications and returns (spec §5.2 "Webhook route", "Return route"). The route
 * handlers in `src/app/api/payments/[provider]/{webhook,return}` are thin wrappers around these.
 *
 * Webhook: authenticate **first** (cheap HMAC/token, no DB) → record the event
 * (`ON CONFLICT … received_count+1 RETURNING processed_at`; processed → 200 duplicate) → resolve
 * the attempt → `finalizeAttempt` → `processed_at` + outcome → 200. An exception or an `unknown`
 * outcome keeps the event unprocessed (`last_error`, the attempt's `next_check_at = now()`) and
 * answers 500 so the provider retries; reconcile replays it too.
 */
export interface WebhookInput {
  provider: string;
  headers: Headers;
  rawBody: string;
  query: URLSearchParams;
  ip: string | null;
}

export interface HttpOutcome {
  status: number;
  body: Record<string, unknown>;
  effects: Effects;
}

export interface WebhookDeps {
  db?: Db;
  env?: Env;
  /** Test seam: replaces `syncPostSuccessEvent` (failure injection). */
  syncPostSuccess?: typeof syncPostSuccessEvent;
}

/**
 * Events that concern a payment we already captured (spec §4.2 PayPal "Events", §5.2 step 4):
 * routed to `syncPostSuccessEvent`, never to `finalizeAttempt`.
 */
export const POST_SUCCESS_EVENT_TYPES = {
  "PAYMENT.CAPTURE.REFUNDED": "refund",
  "PAYMENT.CAPTURE.REVERSED": "reversal",
  "CUSTOMER.DISPUTE.CREATED": "dispute",
} as const satisfies Record<string, PostSuccessEvent["kind"]>;

export function postSuccessKind(
  eventType: string | null | undefined,
): PostSuccessEvent["kind"] | null {
  if (!eventType) return null;
  return (
    (POST_SUCCESS_EVENT_TYPES as Record<string, PostSuccessEvent["kind"]>)[
      eventType
    ] ?? null
  );
}

/**
 * The part of a PayPal webhook the adapter keeps in `payload_redacted` for post-success events
 * (WS5 `parseNotification` contract; no PII): the refund or dispute resource's id, status, amount,
 * `custom_id` (our refund id), the `up` link to the capture, and the disputed capture ids.
 */
export interface PostSuccessPayload {
  resource?: {
    id?: unknown;
    status?: unknown;
    custom_id?: unknown;
    amount?: { value?: unknown; currency_code?: unknown };
    links?: { rel?: unknown; href?: unknown }[];
    disputed_transactions?: { seller_transaction_id?: unknown }[];
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 200) : null;
}

/** Capture id from the refund's `up` link (`…/v2/payments/captures/<id>`) or the dispute. */
export function captureIdOf(p: PostSuccessPayload): string | null {
  const r = p.resource;
  const up = r?.links?.find((l) => l.rel === "up");
  const href = str(up?.href);
  const fromLink = href ? /\/captures\/([^/?#]+)/.exec(href)?.[1] : undefined;
  if (fromLink) return fromLink;
  return str(r?.disputed_transactions?.[0]?.seller_transaction_id);
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

const reply = (
  status: number,
  body: Record<string, unknown>,
  effects: Effects = NO_EFFECTS,
): HttpOutcome => ({ status, body, effects });

export async function handlePaymentWebhook(
  i: WebhookInput,
  deps: WebhookDeps = {},
): Promise<HttpOutcome> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  if (!isProviderId(i.provider))
    return reply(404, { error: "unknown_provider" });
  const provider = buildProvider(i.provider, { env: e });
  if (!provider) return reply(404, { error: "not_configured" });
  const ip = i.ip ?? "unknown-ip";

  if (i.provider === "paypal") {
    const pre = await checkLimit("paypalPreverifyIp", ip, { db });
    if (!pre.allowed) return reply(429, { error: "rate_limited" });
  }
  let authenticated = false;
  try {
    authenticated = await provider.authenticateNotification({
      headers: i.headers,
      rawBody: i.rawBody,
      query: i.query,
      ip,
    });
  } catch (error) {
    log.warn("payments.webhook_auth_error", { provider: i.provider }, error);
    authenticated = false;
  }
  if (!authenticated) {
    const r = await checkLimit("webhookAuthFailureIp", ip, { db });
    return r.allowed
      ? reply(401, { error: "unauthenticated" })
      : reply(429, { error: "rate_limited" });
  }

  const parsed = provider.parseNotification({
    headers: i.headers,
    rawBody: i.rawBody,
    query: i.query,
  });
  let eventId: string;
  try {
    const result = await db.execute<{
      id: string;
      processed_at: Date | null;
    }>(sql`
      INSERT INTO payment_events (provider, event_key, event_type, authenticated, payload_redacted)
      VALUES (${PROVIDER_DB_VALUE[i.provider]}, ${parsed.eventKey}, ${parsed.eventType ?? null}, true, ${JSON.stringify(parsed.payloadRedacted ?? null)}::jsonb)
      ON CONFLICT (provider, event_key) DO UPDATE
        SET received_count = payment_events.received_count + 1, updated_at = now()
      RETURNING id, processed_at`);
    const row = result.rows[0];
    if (!row) return reply(500, { error: "event_not_recorded" });
    if (row.processed_at) return reply(200, { ok: true, duplicate: true });
    eventId = row.id;
  } catch (error) {
    log.error(
      "payments.webhook_event_insert_failed",
      { provider: i.provider },
      error,
    );
    return reply(500, { error: "db" });
  }

  return processPaymentEvent(
    eventId,
    {
      attemptId: parsed.attemptId,
      providerRef: parsed.providerRef,
      refundCustomId: parsed.refundCustomId,
    },
    { ...deps, db, env: e },
  );
}

/**
 * Processes one recorded event (webhook, or reconcile replaying an unprocessed one): resolve the
 * attempt, finalize it, then mark the event processed — or record the error and answer 500.
 */
export async function processPaymentEvent(
  eventId: string,
  hint: {
    attemptId?: string;
    providerRef?: string;
    refundCustomId?: string;
  } = {},
  deps: WebhookDeps = {},
): Promise<HttpOutcome> {
  const db = deps.db ?? defaultDb;
  const [event] = await db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.id, eventId));
  if (!event) return reply(404, { error: "unknown_event" });
  if (event.processedAt) return reply(200, { ok: true, duplicate: true });

  const kind = postSuccessKind(event.eventType);
  if (kind) return processPostSuccess(event, kind, hint, { ...deps, db });

  const payload = (event.payloadRedacted ?? {}) as { ref?: unknown };
  const providerRef =
    hint.providerRef ??
    (typeof payload.ref === "string" ? payload.ref : undefined);
  let attemptId = event.attemptId ?? hint.attemptId ?? null;
  if (attemptId) {
    const [found] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.id, attemptId),
          eq(paymentAttempts.provider, event.provider),
        ),
      );
    attemptId = found?.id ?? null;
  } else if (providerRef) {
    const [found] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, event.provider),
          eq(paymentAttempts.providerRef, providerRef),
        ),
      );
    attemptId = found?.id ?? null;
  }
  const markProcessed = (outcome: string, attempt: string | null) =>
    db
      .update(paymentEvents)
      .set({
        processedAt: new Date(),
        outcome,
        attemptId: attempt,
        lastError: null,
      })
      .where(eq(paymentEvents.id, event.id));

  if (!attemptId) {
    await raiseAlert(
      {
        severity: "WARNING",
        kind: "PAYMENT_EVENT_UNMATCHED",
        dedupeKey: `event-unmatched:${event.id}`,
        entity: "payment_event",
        entityId: event.id,
      },
      db,
    );
    await markProcessed("unmatched", null);
    return reply(200, { ok: true, outcome: "unmatched" });
  }

  try {
    const { result, effects } = await finalizeAttempt(attemptId, {
      trigger: "webhook",
      db,
      env: deps.env,
    });
    if (result.outcome === "unknown") {
      throw new Error("finalize outcome unknown (provider unavailable)");
    }
    await markProcessed(result.outcome, attemptId);
    return reply(200, { ok: true, outcome: result.outcome }, effects);
  } catch (error) {
    const text =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    log.error(
      "payments.webhook_processing_failed",
      { eventId: event.id },
      error,
    );
    await db
      .update(paymentEvents)
      .set({ lastError: text.slice(0, 1000), attemptId })
      .where(eq(paymentEvents.id, event.id))
      .catch(() => {});
    await db
      .update(paymentAttempts)
      .set({ nextCheckAt: new Date() })
      .where(eq(paymentAttempts.id, attemptId))
      .catch(() => {});
    return reply(500, { error: "processing_failed" });
  }
}

/** Unprocessed events 2 min – 3 days old (reconcile step 1). */
export async function unprocessedEventIds(
  limit: number,
  db: Db = defaultDb,
): Promise<string[]> {
  const rows = await db
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      sql`${paymentEvents.processedAt} IS NULL AND ${paymentEvents.receivedAt} < now() - interval '2 minutes' AND ${paymentEvents.receivedAt} > now() - interval '3 days'`,
    )
    .orderBy(paymentEvents.receivedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------- return route

export const RETURN_FINALIZE_BUDGET_MS = 8000;

export interface ReturnInput {
  provider: string;
  query: URLSearchParams;
  ip: string | null;
}

/**
 * `GET /api/payments/[provider]/return?a&r&l&s` (spec §5.2): 60/min/IP; a bad `r` → 303 to
 * `/[l]/checkout/returned`; `s=cancel` → the order page with `&payment=canceled`; otherwise
 * finalize within an 8 s budget and 303 with `&payment=<outcome>`. The `s` hint is never trusted.
 */
export async function handlePaymentReturn(
  i: ReturnInput,
  deps: WebhookDeps = {},
): Promise<{ status: number; location?: string; effects: Effects }> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const l = i.query.get("l");
  const locale: Locale = isLocale(l) ? l : "he";
  const limited = await checkLimit("returnIp", i.ip ?? "unknown-ip", { db });
  if (!limited.allowed) return { status: 429, effects: NO_EFFECTS };

  const returned = absoluteUrl(
    e.APP_URL,
    localePath(locale, paths.checkoutReturned()),
  );
  const a = i.query.get("a") ?? "";
  const r = i.query.get("r");
  if (!isProviderId(i.provider) || !/^[0-9a-f-]{36}$/i.test(a)) {
    return { status: 303, location: returned, effects: NO_EFFECTS };
  }
  if (!verifyHmacToken("return", a, r)) {
    return { status: 303, location: returned, effects: NO_EFFECTS };
  }
  const [row] = await db
    .select({
      id: orders.id,
      number: orders.number,
      accessVersion: orders.accessVersion,
    })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(
      and(
        eq(paymentAttempts.id, a),
        eq(paymentAttempts.provider, PROVIDER_DB_VALUE[i.provider]),
      ),
    );
  if (!row) return { status: 303, location: returned, effects: NO_EFFECTS };

  if (i.query.get("s") === "cancel") {
    return {
      status: 303,
      location: orderUrlFor(row, locale, { payment: "canceled" }, e),
      effects: NO_EFFECTS,
    };
  }
  let outcome: FinalizeOutcome | "pending" = "pending";
  let effects: Effects = NO_EFFECTS;
  try {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), RETURN_FINALIZE_BUDGET_MS).unref?.(),
    );
    const finalized = await Promise.race([
      finalizeAttempt(a, { trigger: "return", db, env: e }),
      timeout,
    ]);
    if (finalized) {
      outcome = buyerOutcome(
        finalized.result.outcome,
        finalized.result.attemptStatus,
      );
      effects = mergeEffects(effects, finalized.effects);
    }
  } catch (error) {
    log.error("payments.return_finalize_failed", { attemptId: a }, error);
    outcome = "pending";
  }
  return {
    status: 303,
    location: orderUrlFor(row, locale, { payment: outcome }, e),
    effects,
  };
}

/**
 * The order page message for a return: a payment the webhook already finalized is reported by its
 * final state ("paid"), not as "already processed".
 */
export function buyerOutcome(
  outcome: FinalizeOutcome,
  attemptStatus: string,
): FinalizeOutcome {
  if (outcome !== "already_final") return outcome;
  switch (attemptStatus) {
    case "SUCCEEDED":
      return "paid";
    case "NEEDS_REFUND":
      return "needs_refund";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "canceled";
    default:
      return outcome;
  }
}

// ---------------------------------------------------------------- post-success events

/**
 * A refund, reversal or dispute of a captured payment (PayPal REFUNDED / REVERSED /
 * CUSTOMER.DISPUTE.CREATED). The attempt is found by our refund id (`custom_id`), the hint, the
 * capture id, or the provider reference; then `syncPostSuccessEvent` matches our own refund rows
 * first and records only an unmatched refund as EXTERNAL. Errors answer 500 and keep the event
 * unprocessed (the provider retries; reconcile replays it).
 */
async function processPostSuccess(
  event: PaymentEvent,
  kind: PostSuccessEvent["kind"],
  hint: { attemptId?: string; providerRef?: string; refundCustomId?: string },
  deps: WebhookDeps & { db: Db },
): Promise<HttpOutcome> {
  const db = deps.db;
  const payload = (event.payloadRedacted ?? {}) as PostSuccessPayload;
  const r = payload.resource ?? {};
  const customId = hint.refundCustomId ?? str(r.custom_id);
  const refundCustomId = customId && UUID_RE.test(customId) ? customId : null;
  const captureId = captureIdOf(payload);

  let attemptId: string | null = event.attemptId ?? hint.attemptId ?? null;
  if (!attemptId && refundCustomId) {
    const [row] = await db
      .select({ attemptId: refunds.attemptId })
      .from(refunds)
      .where(eq(refunds.id, refundCustomId));
    attemptId = row?.attemptId ?? null;
  }
  if (!attemptId && captureId) {
    const [row] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, event.provider),
          eq(paymentAttempts.captureId, captureId),
        ),
      );
    attemptId = row?.id ?? null;
  }
  if (!attemptId && hint.providerRef) {
    const [row] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, event.provider),
          eq(paymentAttempts.providerRef, hint.providerRef),
        ),
      );
    attemptId = row?.id ?? null;
  }
  const mark = (outcome: string, attempt: string | null) =>
    db
      .update(paymentEvents)
      .set({
        processedAt: new Date(),
        outcome,
        attemptId: attempt,
        lastError: null,
      })
      .where(eq(paymentEvents.id, event.id));
  if (!attemptId) {
    await raiseAlert(
      {
        severity: "CRITICAL",
        kind: "PAYMENT_EVENT_UNMATCHED",
        dedupeKey: `event-unmatched:${event.id}`,
        entity: "payment_event",
        entityId: event.id,
        params: { eventType: event.eventType ?? kind },
      },
      db,
    );
    await mark("unmatched", null);
    return reply(200, { ok: true, outcome: "unmatched" });
  }

  try {
    let sync: PostSuccessEvent;
    if (kind === "refund") {
      const currency = str(r.amount?.currency_code);
      const value = r.amount?.value;
      if (!currency || !isCurrency(currency) || value === undefined) {
        throw new Error("refund event without a usable amount");
      }
      const providerRefundId = str(r.id);
      sync = {
        kind: "refund",
        attemptId,
        ...(refundCustomId ? { refundCustomId } : {}),
        ...(providerRefundId ? { providerRefundId } : {}),
        amountMinor: fromDecimal(String(value)),
        currency,
        completed: str(r.status) === "COMPLETED",
      };
    } else {
      sync = { kind, attemptId };
    }
    const run = deps.syncPostSuccess ?? syncPostSuccessEvent;
    const { result, effects } = await run(sync, { db });
    await mark(`${kind}:${result.outcome}`, attemptId);
    return reply(200, { ok: true, outcome: result.outcome }, effects);
  } catch (error) {
    const text =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    log.error(
      "payments.post_success_failed",
      { eventId: event.id, kind },
      error,
    );
    await db
      .update(paymentEvents)
      .set({ lastError: text.slice(0, 1000), attemptId })
      .where(eq(paymentEvents.id, event.id))
      .catch(() => {});
    return reply(500, { error: "processing_failed" });
  }
}
