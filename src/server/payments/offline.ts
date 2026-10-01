import "server-only";
import { eq, max } from "drizzle-orm";
import { type Currency, money } from "@/lib/money";
import { audit } from "@/server/audit";
import { FRESH_SESSION_MAX_AGE_MS } from "@/server/auth/policy";
import {
  lockArtworks,
  lockOrder,
  orderArtworkIds,
  ordersWithAttemptInFlight,
} from "@/server/checkout/reservations";
import type { Db, Tx } from "@/server/db/client";
import { orders, paymentAttempts } from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/server/domain/errors";
import { applySuccessfulPayment } from "./apply";
import type { VerifiedPayment } from "./types";

/**
 * `recordOfflinePayment()` (spec §4.2 "Offline payments", §5.10 "Record payment received"; frozen
 * contract): a fresh admin session; `amountMinor === order.total_minor && currency ===
 * order.currency` (otherwise refused: the admin requotes the order first); one transaction that
 * locks artworks → order, inserts an OFFLINE / MANUAL attempt bound to the order's
 * `quote_version`, and applies it through the same `applySuccessfulPayment` as online payments
 * (sale, PAID, shipment row, confirmation and disclosure email, receipt job with the right
 * payment type). A payment that cannot be applied (the work was sold meanwhile) becomes
 * NEEDS_REFUND with a MANUAL_REQUIRED refund: refunds of offline payments are always manual.
 */
export type OfflinePaymentMethod =
  | "transfer"
  | "cash"
  | "cheque"
  | "bit"
  | "card"
  | "other";

export const OFFLINE_PAYMENT_METHODS = [
  "transfer",
  "cash",
  "cheque",
  "bit",
  "card",
  "other",
] as const satisfies readonly OfflinePaymentMethod[];

export interface OfflinePaymentInput {
  method: OfflinePaymentMethod;
  amountMinor: number;
  currency: Currency;
  reference: string;
  receivedAt: Date;
}

export interface OfflinePaymentDeps {
  db?: Db;
  /** Clock for the fresh-session and future-date checks (tests). */
  now?: Date;
}

/** Highest attempt `seq` allowed by the `payment_attempts_seq_range` CHECK. */
const MAX_SEQ = 5;
/** A receipt time this far in the future is a typo, not a payment. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

export async function recordOfflinePayment(
  orderId: string,
  input: OfflinePaymentInput,
  ctx: AdminContext,
  deps: OfflinePaymentDeps = {},
): Promise<
  ServiceResult<{ attemptId: string; outcome: "paid" | "needs_refund" }>
> {
  const now = deps.now ?? new Date();
  if (
    now.getTime() - ctx.sessionCreatedAt.getTime() >
    FRESH_SESSION_MAX_AGE_MS
  ) {
    throw new ConflictError(
      "FRESH_SESSION_REQUIRED",
      "sign in again to record a payment",
    );
  }
  if (!(OFFLINE_PAYMENT_METHODS as readonly string[]).includes(input.method)) {
    throw new ValidationError("METHOD", "unknown offline payment method");
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError("AMOUNT", "the amount must be > 0");
  }
  const reference = input.reference.trim().slice(0, 200);
  if (!reference && input.method !== "cash") {
    throw new ValidationError("REFERENCE", "a payment reference is required");
  }
  if (
    Number.isNaN(input.receivedAt.getTime()) ||
    input.receivedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS
  ) {
    throw new ValidationError("RECEIVED_AT", "the receipt time is invalid");
  }

  const result = await withTx(
    (tx) => recordTx(tx, orderId, { ...input, reference }, ctx),
    { db: deps.db, name: "payments.offline" },
  );
  return withEffects(result, { outbox: true, revalidate: true });
}

async function recordTx(
  tx: Tx,
  orderId: string,
  input: OfflinePaymentInput,
  ctx: AdminContext,
): Promise<{ attemptId: string; outcome: "paid" | "needs_refund" }> {
  // Lock order (spec §2.2): artworks → order → (the new attempt).
  await lockArtworks(tx, await orderArtworkIds(tx, orderId));
  const order = await lockOrder(tx, orderId);
  if (!order) throw new NotFoundError("order", orderId);
  if (order.status !== "AWAITING_PAYMENT" && order.status !== "EXPIRED") {
    throw new ConflictError(
      "ORDER_NOT_PAYABLE",
      `the order is ${order.status}`,
    );
  }
  if ((await ordersWithAttemptInFlight(tx, [order.id])).size > 0) {
    throw new ConflictError(
      "PAYMENT_IN_FLIGHT",
      "an online payment is being confirmed",
    );
  }
  if (
    input.amountMinor !== order.totalMinor ||
    input.currency !== order.currency
  ) {
    throw new ValidationError(
      "AMOUNT_MISMATCH",
      "the amount must equal the order total (requote the order first)",
      { totalMinor: order.totalMinor, currency: order.currency },
    );
  }
  const [seqRow] = await tx
    .select({ n: max(paymentAttempts.seq) })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, order.id));
  const seq = (seqRow?.n ?? 0) + 1;
  if (seq > MAX_SEQ) {
    throw new ConflictError(
      "TOO_MANY_ATTEMPTS",
      "this order has no attempt slot left",
    );
  }

  const raw = {
    method: input.method,
    reference: input.reference,
    receivedAt: input.receivedAt.toISOString(),
    recordedBy: ctx.actor,
  };
  const [attempt] = await tx
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      seq,
      provider: "OFFLINE",
      providerMode: "MANUAL",
      merchantRef: null,
      isDemo: order.isDemo,
      status: "CREATED",
      quoteVersion: order.quoteVersion,
      amountMinor: order.totalMinor,
      currency: order.currency,
      method: input.method,
    })
    .returning();
  if (!attempt) throw new Error("attempt insert returned no row");

  const verified: VerifiedPayment = {
    state: "succeeded",
    amount: money(input.amountMinor, input.currency),
    echoedReference: attempt.id,
    merchantRef: null,
    method: input.method,
    ...(input.reference ? { transactionId: input.reference } : {}),
    rawRedacted: raw,
  };
  const applied = await applySuccessfulPayment(tx, {
    attemptId: attempt.id,
    verified,
    actor: ctx.actor,
  });
  if (applied.kind === "applied") {
    // The money arrived when the admin says it did (turnover and the timeline use paid_at).
    await tx
      .update(orders)
      .set({ paidAt: input.receivedAt })
      .where(eq(orders.id, order.id));
  } else if (applied.kind !== "needs_refund") {
    throw new ConflictError("NOT_APPLIED", `payment ${applied.kind}`);
  }
  await audit(
    {
      actor: ctx.actor,
      action: "payment.offline_recorded",
      entity: "order",
      entityId: order.id,
      after: {
        attemptId: attempt.id,
        ...raw,
        amountMinor: input.amountMinor,
        currency: input.currency,
        outcome: applied.kind,
      },
      ipHash: ctx.ipHash,
    },
    tx,
  );
  return {
    attemptId: attempt.id,
    outcome: applied.kind === "applied" ? "paid" : "needs_refund",
  };
}
