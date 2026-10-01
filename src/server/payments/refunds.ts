import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, lte, sql } from "drizzle-orm";
import { raiseAlert } from "@/server/alerts/service";
import { audit } from "@/server/audit";
import {
  type Db,
  type DbOrTx,
  db as defaultDb,
  type Tx,
} from "@/server/db/client";
import {
  outboxJobs,
  type PaymentAttempt,
  paymentAttempts,
  type Refund,
  refunds,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { refundInvoiceId } from "@/server/domain/ids";
import type { RefundStatus } from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import type { Env } from "@/server/env";
import {
  isProviderError,
  ProviderNotConfiguredError,
} from "@/server/integrations/http";
import { log } from "@/server/log";
import { enqueue, enqueueEmail } from "@/server/outbox/enqueue";
import { dedupeKeys } from "@/server/outbox/types";
import { providerForAttempt } from "./registry";
import type { RefundResult } from "./types";

/**
 * Two-phase refunds (spec §5.7 step 8; frozen contract). `requestRefund` inserts REQUESTED under
 * the cap (captured − Σ rows except FAILED-with-failure_confirmed_at ≥ amount) and enqueues
 * `refund:<id>`; `executeRefund` claims REQUESTED → IN_FLIGHT, commits, calls the provider
 * outside any transaction and records SUCCEEDED / PROVIDER_PENDING / MANUAL_REQUIRED / UNKNOWN /
 * FAILED. It never calls the provider for a row it did not move from REQUESTED itself.
 *
 * Lock order: order → attempt → refunds (spec §2.2).
 */
export type RefundReason =
  | "CANCELLATION"
  | "LOST_RESERVATION"
  | "DUPLICATE_PAYMENT"
  | "ORDER_CANCELLED"
  | "STALE_QUOTE"
  | "AMOUNT_MISMATCH"
  | "ADMIN"
  | "EXTERNAL";

export interface RequestRefundInput {
  attemptId: string;
  amountMinor: number;
  reason: RefundReason;
  cancellationId?: string;
  /** Audit actor (`admin:<id>`, `system`). */
  requestedBy: string;
  /** Legal deadline (cancellations: received + 14 days). */
  legalDueAt?: Date;
  feeWithheldMinor?: number;
}

export interface RefundDeps {
  db?: Db;
  env?: Env;
}

/** The refund lease: an IN_FLIGHT row older than this is never called again, only reconciled. */
export const REFUND_LEASE_MS = 2 * 60_000;
const LEGAL_REFUND_DAYS = 14;

/** Attempt statuses in which the money was captured. */
const CAPTURED_STATUSES = new Set<PaymentAttempt["status"]>([
  "SUCCEEDED",
  "NEEDS_REFUND",
  "REFUNDED",
]);

function isTx(db: DbOrTx): db is Tx {
  return typeof (db as { rollback?: unknown }).rollback === "function";
}

/** Runs `fn` in the caller's transaction, or in a new one. */
async function inTx<T>(
  db: DbOrTx | undefined,
  fn: (tx: Tx) => Promise<T>,
  name: string,
): Promise<T> {
  if (db && isTx(db)) return fn(db);
  return withTx(fn, { db: db as Db | undefined, name });
}

/** Σ of the rows that count toward "refunded or possibly refunded" (all but confirmed FAILED). */
export function countedRefundsMinor(
  rows: readonly Pick<
    Refund,
    "amountMinor" | "status" | "failureConfirmedAt"
  >[],
): number {
  return rows
    .filter((r) => !(r.status === "FAILED" && r.failureConfirmedAt !== null))
    .reduce((s, r) => s + r.amountMinor, 0);
}

export function legalRefundDueAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + LEGAL_REFUND_DAYS * 24 * 60 * 60_000);
}

export async function lockChain(tx: Tx, attemptId: string) {
  const [ref] = await tx
    .select({ orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId));
  if (!ref) throw new NotFoundError("payment_attempt", attemptId);
  await tx.execute(
    sql`SELECT id FROM orders WHERE id = ${ref.orderId} FOR UPDATE`,
  );
  const [attempt] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId))
    .for("update");
  if (!attempt) throw new NotFoundError("payment_attempt", attemptId);
  const rows = await tx
    .select()
    .from(refunds)
    .where(eq(refunds.attemptId, attemptId))
    .orderBy(refunds.createdAt)
    .for("update");
  return { attempt, rows };
}

/**
 * Inserts a REQUESTED refund under the cap and enqueues `refund:<id>`. Runs in the caller's
 * transaction when `db` is one (finalize's NEEDS_REFUND path), otherwise in its own. Refunds of
 * offline payments go straight to MANUAL_REQUIRED (no provider call is possible).
 */
export async function requestRefund(
  input: RequestRefundInput,
  db?: DbOrTx,
): Promise<ServiceResult<{ refundId: string }>> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ConflictError("REFUND_AMOUNT", "refund amount must be > 0");
  }
  const refundId = await inTx(
    db,
    async (tx) => {
      const { attempt, rows } = await lockChain(tx, input.attemptId);
      if (!CAPTURED_STATUSES.has(attempt.status)) {
        throw new ConflictError(
          "NOTHING_CAPTURED",
          "the attempt has no captured payment",
        );
      }
      const available = attempt.amountMinor - countedRefundsMinor(rows);
      if (input.amountMinor > available) {
        throw new ConflictError(
          "REFUND_EXCEEDS_CAPTURED",
          "the refund exceeds what was captured and not yet (possibly) refunded",
          { availableMinor: available },
        );
      }
      const offline = attempt.provider === "OFFLINE";
      const [row] = await tx
        .insert(refunds)
        .values({
          attemptId: attempt.id,
          orderId: attempt.orderId,
          cancellationId: input.cancellationId ?? null,
          amountMinor: input.amountMinor,
          currency: attempt.currency,
          feeWithheldMinor: input.feeWithheldMinor ?? 0,
          reason: input.reason,
          status: offline ? "MANUAL_REQUIRED" : "REQUESTED",
          idemKey: randomUUID(),
          requestedBy: input.requestedBy,
          legalDueAt: input.legalDueAt ?? legalRefundDueAt(),
        })
        .returning({ id: refunds.id });
      if (!row) throw new Error("refund insert returned no row");
      if (offline) {
        await raiseAlert(
          {
            severity: "WARNING",
            kind: "REFUND_MANUAL_REQUIRED",
            dedupeKey: `refund-manual:${row.id}`,
            entity: "refund",
            entityId: row.id,
            params: { reason: input.reason, amountMinor: input.amountMinor },
          },
          tx,
        );
      } else {
        await enqueue(tx, {
          kind: "REFUND_PAYMENT",
          dedupeKey: dedupeKeys.refund(row.id),
          payload: { refundId: row.id },
        });
      }
      await audit(
        {
          actor: input.requestedBy,
          action: "refund.requested",
          entity: "refund",
          entityId: row.id,
          after: {
            attemptId: attempt.id,
            amountMinor: input.amountMinor,
            reason: input.reason,
            status: offline ? "MANUAL_REQUIRED" : "REQUESTED",
          },
        },
        tx,
      );
      return row.id;
    },
    "refund.request",
  );
  return withEffects({ refundId }, { outbox: true });
}

type ClaimResult =
  | { claimed: false; status: RefundStatus }
  | {
      claimed: true;
      refund: Refund;
      attempt: PaymentAttempt;
      orderNumber: string;
      priorRefunds: number;
      capturedMinor: number;
    };

/**
 * Phase 2 (spec §5.7 step 8.2–8.4). Claims REQUESTED → IN_FLIGHT and commits; an IN_FLIGHT row
 * whose lease expired, or an UNKNOWN row, is **never** called again: it becomes UNKNOWN for the
 * reconcile job. The provider is called outside any transaction; the result transaction touches
 * the refund row only.
 */
export async function executeRefund(
  refundId: string,
  deps: RefundDeps = {},
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const db = deps.db ?? defaultDb;
  const claim = await withTx(
    async (tx): Promise<ClaimResult> => {
      const [head] = await tx
        .select({ attemptId: refunds.attemptId })
        .from(refunds)
        .where(eq(refunds.id, refundId));
      if (!head) throw new NotFoundError("refund", refundId);
      const { attempt, rows } = await lockChain(tx, head.attemptId);
      const refund = rows.find((r) => r.id === refundId);
      if (!refund) throw new NotFoundError("refund", refundId);
      if (refund.status === "IN_FLIGHT") {
        if (
          refund.inFlightUntil &&
          refund.inFlightUntil.getTime() <= Date.now()
        ) {
          await transition(
            tx,
            "refund",
            refund.id,
            ["IN_FLIGHT"],
            "UNKNOWN",
            { error: "lease expired before a result was recorded" },
            "system",
          );
          return { claimed: false, status: "UNKNOWN" };
        }
        return { claimed: false, status: "IN_FLIGHT" };
      }
      if (refund.status !== "REQUESTED") {
        return { claimed: false, status: refund.status };
      }
      const [order] = await tx
        .execute<{ number: string }>(
          sql`SELECT number FROM orders WHERE id = ${refund.orderId}`,
        )
        .then((r) => r.rows);
      const claimed = await transition(
        tx,
        "refund",
        refund.id,
        ["REQUESTED"],
        "IN_FLIGHT",
        {
          providerCalls: refund.providerCalls + 1,
          inFlightUntil: new Date(Date.now() + REFUND_LEASE_MS),
        },
        "system",
        { skipAudit: true },
      );
      return {
        claimed: true,
        refund: claimed,
        attempt,
        orderNumber: order?.number ?? "",
        priorRefunds: rows.filter(
          (r) =>
            r.id !== refund.id &&
            !(r.status === "FAILED" && r.failureConfirmedAt !== null),
        ).length,
        capturedMinor: attempt.amountMinor,
      };
    },
    { db, name: "refund.claim" },
  );
  if (!claim.claimed) return withEffects({ status: claim.status });

  const { refund, attempt } = claim;
  let outcome:
    | { kind: "result"; result: RefundResult }
    | { kind: "unknown"; error: string }
    | { kind: "manual"; error: string }
    | { kind: "failed"; error: string };
  const pfa = await providerForAttempt(attempt, { env: deps.env, db });
  if (pfa.kind !== "ok") {
    outcome = { kind: "manual", error: `provider ${pfa.kind}` };
  } else if (!attempt.transactionId && !attempt.captureId) {
    outcome = { kind: "manual", error: "no transaction id recorded" };
  } else {
    try {
      const result = await pfa.provider.refund({
        refundId: refund.id,
        transactionId: attempt.transactionId ?? attempt.captureId ?? "",
        ...(attempt.captureId ? { captureId: attempt.captureId } : {}),
        amount: { amountMinor: refund.amountMinor, currency: refund.currency },
        isFull:
          claim.priorRefunds === 0 &&
          refund.amountMinor === claim.capturedMinor,
        idemKey: refund.idemKey,
        priorRefunds: claim.priorRefunds,
        invoiceRef: refundInvoiceId(claim.orderNumber, claim.priorRefunds + 1),
        reason: refund.reason,
      });
      outcome = { kind: "result", result };
    } catch (error) {
      const text =
        error instanceof Error ? `${error.name}: ${error.message}` : "error";
      if (error instanceof ProviderNotConfiguredError) {
        outcome = { kind: "manual", error: text };
      } else if (
        isProviderError(error) &&
        !error.outcomeUnknown &&
        error.name === "ProviderRejectedError"
      ) {
        outcome = { kind: "failed", error: text };
      } else {
        // Timeouts, garbled responses, 5xx: the refund may or may not have happened.
        outcome = { kind: "unknown", error: text };
      }
    }
  }

  const status = await withTx(
    async (tx) => {
      const [row] = await tx
        .select()
        .from(refunds)
        .where(eq(refunds.id, refund.id))
        .for("update");
      if (!row) throw new NotFoundError("refund", refund.id);
      // The lease may have expired meanwhile (reconcile set UNKNOWN): a result still settles it.
      const from: RefundStatus[] = ["IN_FLIGHT", "UNKNOWN"];
      if (
        !from.includes(row.status) ||
        row.providerCalls !== refund.providerCalls
      ) {
        return row.status;
      }
      return recordRefundOutcome(tx, row, outcome);
    },
    { db, name: "refund.result" },
  );
  return withEffects({ status }, { outbox: true });
}

async function recordRefundOutcome(
  tx: Tx,
  row: Refund,
  outcome:
    | { kind: "result"; result: RefundResult }
    | { kind: "unknown"; error: string }
    | { kind: "manual"; error: string }
    | { kind: "failed"; error: string },
): Promise<RefundStatus> {
  const from = [row.status] as ("IN_FLIGHT" | "UNKNOWN")[];
  if (outcome.kind === "result") {
    const r = outcome.result;
    if (r.status === "succeeded") {
      await markRefundSucceeded(tx, row, r.providerRefundId ?? null);
      return "SUCCEEDED";
    }
    if (r.status === "pending" && row.status === "IN_FLIGHT") {
      await transition(
        tx,
        "refund",
        row.id,
        ["IN_FLIGHT"],
        "PROVIDER_PENDING",
        { providerRefundId: r.providerRefundId ?? null, inFlightUntil: null },
        "system",
      );
      return "PROVIDER_PENDING";
    }
    if (r.status === "pending") return row.status;
    return markManualRequired(tx, row, "the provider requires a manual refund");
  }
  if (outcome.kind === "manual") {
    return markManualRequired(tx, row, outcome.error);
  }
  if (outcome.kind === "unknown") {
    if (row.status === "IN_FLIGHT") {
      await transition(
        tx,
        "refund",
        row.id,
        ["IN_FLIGHT"],
        "UNKNOWN",
        { error: outcome.error.slice(0, 500) },
        "system",
      );
    }
    return "UNKNOWN";
  }
  await transition(
    tx,
    "refund",
    row.id,
    from,
    "FAILED",
    { error: outcome.error.slice(0, 500), inFlightUntil: null },
    "system",
  );
  await raiseAlert(
    {
      severity: "CRITICAL",
      kind: "REFUND_FAILED",
      dedupeKey: `refund-failed:${row.id}:${row.providerCalls}`,
      entity: "refund",
      entityId: row.id,
      params: { reason: row.reason, amountMinor: row.amountMinor },
    },
    tx,
  );
  return "FAILED";
}

async function markManualRequired(
  tx: Tx,
  row: Refund,
  error: string,
): Promise<RefundStatus> {
  await transition(
    tx,
    "refund",
    row.id,
    [row.status as "IN_FLIGHT" | "UNKNOWN" | "REQUESTED"],
    "MANUAL_REQUIRED",
    { error: error.slice(0, 500), inFlightUntil: null },
    "system",
  );
  await raiseAlert(
    {
      severity: "CRITICAL",
      kind: "REFUND_MANUAL_REQUIRED",
      dedupeKey: `refund-manual:${row.id}`,
      entity: "refund",
      entityId: row.id,
      params: { reason: row.reason, amountMinor: row.amountMinor },
    },
    tx,
  );
  return "MANUAL_REQUIRED";
}

/** → SUCCEEDED and the `refund-settled:<id>` job (the order/attempt transitions run there). */
export async function markRefundSucceeded(
  tx: Tx,
  row: Refund,
  providerRefundId: string | null,
): Promise<void> {
  await transition(
    tx,
    "refund",
    row.id,
    [row.status as "IN_FLIGHT" | "UNKNOWN" | "PROVIDER_PENDING"],
    "SUCCEEDED",
    {
      providerRefundId: providerRefundId ?? row.providerRefundId,
      completedAt: new Date(),
      inFlightUntil: null,
      error: null,
    },
    "system",
  );
  await enqueue(tx, {
    kind: "REFUND_SETTLED",
    dedupeKey: dedupeKeys.refundSettled(row.id),
    payload: { refundId: row.id },
  });
}

/**
 * Reconcile (spec §5.7 step 8.5, §5.11 step 3): PROVIDER_PENDING and UNKNOWN rows are resolved by
 * querying the provider (`getRefund`), never by calling `refund` again. A provider without
 * `getRefund` (Cardcom without ListTransactions) needs the admin: MANUAL_REQUIRED.
 */
export async function reconcileRefund(
  refundId: string,
  deps: RefundDeps = {},
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const db = deps.db ?? defaultDb;
  const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId));
  if (!row) throw new NotFoundError("refund", refundId);
  if (row.status !== "PROVIDER_PENDING" && row.status !== "UNKNOWN") {
    return withEffects({ status: row.status });
  }
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, row.attemptId));
  if (!attempt) throw new NotFoundError("payment_attempt", row.attemptId);
  const pfa = await providerForAttempt(attempt, { env: deps.env, db });
  let found:
    | "succeeded"
    | "pending"
    | "failed"
    | "not_found"
    | "manual"
    | "error" = "error";
  let providerRefundId: string | undefined;
  if (pfa.kind !== "ok" || !pfa.provider.getRefund) {
    found = "manual";
  } else {
    try {
      const r = await pfa.provider.getRefund({
        refundId: row.id,
        ...(row.providerRefundId
          ? { providerRefundId: row.providerRefundId }
          : {}),
        ...(attempt.captureId ? { captureId: attempt.captureId } : {}),
      });
      found = r.status;
      providerRefundId = r.providerRefundId;
    } catch (error) {
      log.warn("refund.reconcile_failed", { refundId }, error);
      found = "error";
    }
  }
  if (found === "error" || found === "pending") {
    return withEffects({ status: row.status });
  }
  const status = await withTx(
    async (tx) => {
      const { rows } = await lockChain(tx, row.attemptId);
      const current = rows.find((r) => r.id === row.id);
      if (!current || current.status !== row.status) {
        return current?.status ?? row.status;
      }
      if (found === "succeeded") {
        await markRefundSucceeded(tx, current, providerRefundId ?? null);
        return "SUCCEEDED" as const;
      }
      if (found === "manual") {
        if (current.status === "UNKNOWN") {
          return markManualRequired(
            tx,
            current,
            "confirm the refund in the provider dashboard",
          );
        }
        return current.status;
      }
      // failed, or not_found (confirmed absent): FAILED, counted in the cap until confirmed.
      await transition(
        tx,
        "refund",
        current.id,
        [current.status as "UNKNOWN" | "PROVIDER_PENDING"],
        "FAILED",
        { error: `provider reports ${found}` },
        "system",
      );
      await raiseAlert(
        {
          severity: "CRITICAL",
          kind: "REFUND_FAILED",
          dedupeKey: `refund-failed:${current.id}:${current.providerCalls}`,
          entity: "refund",
          entityId: current.id,
          params: { reason: current.reason, amountMinor: current.amountMinor },
        },
        tx,
      );
      return "FAILED" as const;
    },
    { db, name: "refund.reconcile" },
  );
  return withEffects({ status }, { outbox: true });
}

/** IN_FLIGHT rows whose lease expired → UNKNOWN (reconcile step 3). */
export async function expireRefundLeases(
  deps: RefundDeps = {},
): Promise<number> {
  const db = deps.db ?? defaultDb;
  const stale = await db
    .select({ id: refunds.id, attemptId: refunds.attemptId })
    .from(refunds)
    .where(
      and(
        eq(refunds.status, "IN_FLIGHT"),
        lte(refunds.inFlightUntil, sql`now()`),
      ),
    )
    .limit(50);
  let n = 0;
  for (const s of stale) {
    const moved = await withTx(
      async (tx) => {
        const { rows } = await lockChain(tx, s.attemptId);
        const r = rows.find((x) => x.id === s.id);
        if (
          r?.status !== "IN_FLIGHT" ||
          !r.inFlightUntil ||
          r.inFlightUntil.getTime() > Date.now()
        ) {
          return false;
        }
        await transition(
          tx,
          "refund",
          r.id,
          ["IN_FLIGHT"],
          "UNKNOWN",
          { error: "lease expired before a result was recorded" },
          "system",
        );
        return true;
      },
      { db, name: "refund.lease" },
    );
    if (moved) n += 1;
  }
  return n;
}

/** MANUAL_REQUIRED → MANUAL_DONE with the reference the admin copied from the dashboard. */
export async function confirmManualRefund(
  refundId: string,
  reference: string,
  ctx: AdminContext,
  deps: RefundDeps = {},
): Promise<ServiceResult<{ status: RefundStatus }>> {
  const ref = reference.trim();
  if (!ref)
    throw new ConflictError("REFERENCE_REQUIRED", "a reference is required");
  await withTx(
    async (tx) => {
      const [head] = await tx
        .select({ attemptId: refunds.attemptId })
        .from(refunds)
        .where(eq(refunds.id, refundId));
      if (!head) throw new NotFoundError("refund", refundId);
      await lockChain(tx, head.attemptId);
      await transition(
        tx,
        "refund",
        refundId,
        ["MANUAL_REQUIRED"],
        "MANUAL_DONE",
        { manualReference: ref.slice(0, 200), completedAt: new Date() },
        ctx.actor,
        { ipHash: ctx.ipHash },
      );
      await enqueue(tx, {
        kind: "REFUND_SETTLED",
        dedupeKey: dedupeKeys.refundSettled(refundId),
        payload: { refundId },
      });
    },
    { db: deps.db, name: "refund.manual_done" },
  );
  return withEffects({ status: "MANUAL_DONE" }, { outbox: true });
}

/**
 * Sets `failure_confirmed_at` on a FAILED row after the admin checked the provider dashboard: it
 * stops counting toward the cap, and only then may the refund be retried (`retryRefund`).
 */
export async function confirmRefundFailure(
  refundId: string,
  ctx: AdminContext,
  deps: RefundDeps = {},
): Promise<ServiceResult<{ status: RefundStatus }>> {
  await withTx(
    async (tx) => {
      const [head] = await tx
        .select({ attemptId: refunds.attemptId })
        .from(refunds)
        .where(eq(refunds.id, refundId));
      if (!head) throw new NotFoundError("refund", refundId);
      const { rows } = await lockChain(tx, head.attemptId);
      const r = rows.find((x) => x.id === refundId);
      if (r?.status !== "FAILED") {
        throw new ConflictError(
          "NOT_FAILED",
          "only a FAILED refund can be confirmed",
        );
      }
      if (r.failureConfirmedAt) return;
      await tx
        .update(refunds)
        .set({ failureConfirmedAt: new Date(), failureConfirmedBy: ctx.actor })
        .where(eq(refunds.id, refundId));
      await audit(
        {
          actor: ctx.actor,
          action: "refund.failure_confirmed",
          entity: "refund",
          entityId: refundId,
          ipHash: ctx.ipHash,
        },
        tx,
      );
    },
    { db: deps.db, name: "refund.confirm_failure" },
  );
  return withEffects({ status: "FAILED" });
}

/**
 * FAILED → REQUESTED with a new `idem_key`, **only after `failure_confirmed_at`** (spec §3.6).
 * The cap is re-checked (the row counts again once it is live).
 */
export async function retryRefund(
  refundId: string,
  actor: string,
  deps: RefundDeps = {},
): Promise<ServiceResult<{ status: RefundStatus }>> {
  await withTx(
    async (tx) => {
      const [head] = await tx
        .select({ attemptId: refunds.attemptId })
        .from(refunds)
        .where(eq(refunds.id, refundId));
      if (!head) throw new NotFoundError("refund", refundId);
      const { attempt, rows } = await lockChain(tx, head.attemptId);
      const r = rows.find((x) => x.id === refundId);
      if (r?.status !== "FAILED") {
        throw new ConflictError(
          "NOT_FAILED",
          "only a FAILED refund can be retried",
        );
      }
      if (!r.failureConfirmedAt) {
        throw new ConflictError(
          "FAILURE_NOT_CONFIRMED",
          "confirm the failure in the provider dashboard first",
        );
      }
      const available = attempt.amountMinor - countedRefundsMinor(rows);
      if (r.amountMinor > available) {
        throw new ConflictError(
          "REFUND_EXCEEDS_CAPTURED",
          "the refund exceeds the cap",
        );
      }
      const idemKey = randomUUID();
      await transition(
        tx,
        "refund",
        r.id,
        ["FAILED"],
        "REQUESTED",
        {
          idemKey,
          failureConfirmedAt: null,
          failureConfirmedBy: null,
          error: null,
        },
        actor,
        { action: "refund.retried" },
      );
      await enqueue(tx, {
        kind: "REFUND_PAYMENT",
        dedupeKey: `${dedupeKeys.refund(r.id)}:${idemKey}`,
        payload: { refundId: r.id },
      });
    },
    { db: deps.db, name: "refund.retry" },
  );
  return withEffects({ status: "REQUESTED" }, { outbox: true });
}

/**
 * The `REFUND_SETTLED` job (spec §5.4): in order → attempt → refund lock order, a NEEDS_REFUND
 * attempt → REFUNDED; a cancellation refund → order CANCELLED (from PAID or COMPLETED); the credit
 * note job when the attempt had a receipt job; the `refund-issued` email; audit. Idempotent: every
 * step is conditional, so a retried job does nothing twice.
 */
export async function settleRefund(
  refundId: string,
  deps: RefundDeps = {},
): Promise<ServiceResult<{ settled: boolean }>> {
  const settled = await withTx(
    async (tx) => {
      const [head] = await tx
        .select({ attemptId: refunds.attemptId })
        .from(refunds)
        .where(eq(refunds.id, refundId));
      if (!head) throw new NotFoundError("refund", refundId);
      const { attempt, rows } = await lockChain(tx, head.attemptId);
      const refund = rows.find((r) => r.id === refundId);
      if (!refund) throw new NotFoundError("refund", refundId);
      if (refund.status !== "SUCCEEDED" && refund.status !== "MANUAL_DONE") {
        throw new ConflictError(
          "REFUND_NOT_SETTLED",
          `refund is ${refund.status}`,
        );
      }
      const [order] = await tx
        .execute<{
          id: string;
          status: string;
          buyer_email: string | null;
          locale: "he" | "en";
        }>(
          sql`SELECT id, status, buyer_email, locale FROM orders WHERE id = ${refund.orderId}`,
        )
        .then((r) => r.rows);
      if (!order) throw new NotFoundError("order", refund.orderId);

      if (attempt.status === "NEEDS_REFUND") {
        const settledMinor = rows
          .filter((r) => r.status === "SUCCEEDED" || r.status === "MANUAL_DONE")
          .reduce((s, r) => s + r.amountMinor, 0);
        if (
          settledMinor >= attempt.amountMinor ||
          refund.reason !== "EXTERNAL"
        ) {
          await transition(
            tx,
            "attempt",
            attempt.id,
            ["NEEDS_REFUND"],
            "REFUNDED",
            {},
            "system",
          );
        }
      }
      if (
        refund.cancellationId &&
        (order.status === "PAID" || order.status === "COMPLETED")
      ) {
        await transition(
          tx,
          "order",
          order.id,
          ["PAID", "COMPLETED"],
          "CANCELLED",
          { statusReason: "BUYER_CANCELLATION", cancelledAt: new Date() },
          "system",
        );
      }
      const [receiptJob] = await tx
        .select({ n: count() })
        .from(outboxJobs)
        .where(eq(outboxJobs.dedupeKey, dedupeKeys.receipt(attempt.id)));
      if ((receiptJob?.n ?? 0) > 0) {
        await enqueue(tx, {
          kind: "ISSUE_CREDIT_NOTE",
          dedupeKey: dedupeKeys.creditNote(refund.id),
          payload: { refundId: refund.id },
        });
      }
      if (order.buyer_email && refund.reason !== "EXTERNAL") {
        await enqueueEmail(tx, {
          template: "refund-issued",
          to: order.buyer_email,
          locale: order.locale,
          refId: refund.id,
        });
      }
      await audit(
        {
          actor: "system",
          action: "refund.settled",
          entity: "refund",
          entityId: refund.id,
          after: { status: refund.status, amountMinor: refund.amountMinor },
        },
        tx,
      );
      return true;
    },
    { db: deps.db, name: "refund.settle" },
  );
  return withEffects({ settled }, { outbox: true, revalidate: true });
}

/** Refund rows of an order (admin and order pages). */
export async function listRefundsForOrder(
  orderId: string,
  db: DbOrTx = defaultDb,
): Promise<Refund[]> {
  return db
    .select()
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .orderBy(refunds.createdAt);
}

/** Refund rows due for reconcile (PROVIDER_PENDING / UNKNOWN). */
export async function refundsToReconcile(
  limit: number,
  db: DbOrTx = defaultDb,
): Promise<string[]> {
  const rows = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(inArray(refunds.status, ["PROVIDER_PENDING", "UNKNOWN"]))
    .orderBy(refunds.updatedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}
