import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { jerusalemDateKey } from "@/lib/format";
import type { Locale } from "@/lib/locale";
import { raiseAlert } from "@/server/alerts/service";
import { type Db, db as defaultDb, type Tx } from "@/server/db/client";
import {
  orderItems,
  orders,
  outboxJobs,
  type PaymentAttempt,
  paymentAttempts,
  refunds,
  shipments,
  type TaxDocument,
  taxDocuments,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import {
  type Effects,
  type ServiceResult,
  withEffects,
} from "@/server/domain/effects";
import { IllegalTransitionError, NotFoundError } from "@/server/domain/errors";
import { taxDocumentMarker } from "@/server/domain/ids";
import type { TaxDocumentStatus } from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  ProviderNotConfiguredError,
  ProviderRejectedError,
} from "@/server/integrations/http";
import { log } from "@/server/log";
import { enqueueEmail } from "@/server/outbox/enqueue";
import { dedupeKeys } from "@/server/outbox/types";
import { getSetting } from "@/server/settings";
import { taxDocumentProvider } from "./registry";
import {
  type IssuedDocument,
  type IssueReceiptInput,
  TAXDOC_DB_PROVIDER,
  TaxDocumentNeedsManualError,
  type TaxDocumentProvider,
  type TaxPaymentType,
} from "./types";

/**
 * The tax-document pipeline (spec §4.3 "Which payments get a receipt", "Exactly once",
 * "Credit-note handler"). Called by the `ISSUE_TAX_DOCUMENT` / `ISSUE_CREDIT_NOTE` outbox handlers.
 *
 * - Receipts: every SUCCEEDED attempt, and NEEDS_REFUND / REFUNDED attempts other than
 *   AMOUNT_MISMATCH (unless `settings.checkout.receiptForRefundedPayments` is off).
 * - Exactly once: the `tax_documents(ISSUING, marker)` row is inserted (the claim) and committed
 *   before the provider call. Timeout / 5xx / garbled answer → UNKNOWN. An UNKNOWN row is retried
 *   no sooner than 5 min later, and always searches by marker first: found → ISSUED; confirmed
 *   absent → ISSUING again (a new claimed call); 3 inconclusive searches → NEEDS_MANUAL + alert.
 *   A clear refusal (4xx) → FAILED + alert (admin retry). A mode that cannot document the payment
 *   → NEEDS_MANUAL + alert.
 * - `tax_documents.attempts` counts provider calls while ISSUING and inconclusive searches while
 *   UNKNOWN (reset to 0 on entering UNKNOWN). An ISSUING row whose last call is older than
 *   `CALL_LEASE_MS` (a worker died mid-call) is treated as UNKNOWN.
 * - After a receipt is ISSUED: the `receipt` email when the buyer consented, otherwise "print the
 *   receipt" is added to the shipment checklist.
 * - Credit notes reschedule while the receipt is missing, ISSUING or UNKNOWN; they become
 *   NEEDS_MANUAL only when the receipt ends FAILED or NEEDS_MANUAL.
 */
export type IssueOutcome =
  | { kind: "issued"; taxDocumentId: string; status: TaxDocumentStatus }
  | { kind: "skipped"; reason: "not_eligible" | "already_issued" | "disabled" }
  | { kind: "reschedule"; delayMs: number; reason: string }
  | { kind: "needs_manual"; taxDocumentId: string }
  /** A clear refusal: the row is FAILED until an admin retries. */
  | { kind: "failed"; taxDocumentId: string };

export interface TaxDocDeps {
  db?: Db;
  env?: Env;
  provider?: TaxDocumentProvider;
}

/** Minimum gap before an UNKNOWN row is searched again (spec §4.3 step 3). */
export const UNKNOWN_RETRY_MS = 5 * 60_000;
export const MAX_INCONCLUSIVE_SEARCHES = 3;
/** An ISSUING row whose call started longer ago than this is considered abandoned. */
export const CALL_LEASE_MS = 2 * 60_000;
/** Credit note waiting for its receipt. */
export const RECEIPT_WAIT_MS = 10 * 60_000;

const RECEIPT_KINDS = ["RECEIPT", "INVOICE_RECEIPT"] as const;

interface Ctx {
  db: Db;
  env: Env;
  provider: TaxDocumentProvider;
}

function ctxOf(deps: TaxDocDeps): Ctx {
  const env = deps.env ?? defaultEnv;
  return {
    db: deps.db ?? defaultDb,
    env,
    provider: deps.provider ?? taxDocumentProvider({ env }),
  };
}

const LINE_TEXT = {
  he: { shipping: "משלוח", insurance: "ביטוח משלוח", order: "הזמנה" },
  en: { shipping: "Shipping", insurance: "Shipping insurance", order: "Order" },
} as const;

function paymentTypeOf(a: PaymentAttempt): TaxPaymentType {
  if (a.provider === "PAYPAL") return "paypal";
  const m = (a.method ?? "").toLowerCase();
  if (a.provider === "OFFLINE") {
    return m === "transfer" || m === "cash" || m === "cheque" ? m : "other";
  }
  if (m === "bit" || m === "apple_pay" || m === "google_pay") return m;
  return "card";
}

// ---------------------------------------------------------------- receipts

/** Receipt eligibility (spec §4.3 "Which payments get a receipt"). */
async function receiptEligible(c: Ctx, attempt: PaymentAttempt) {
  if (attempt.status === "SUCCEEDED") return true;
  if (attempt.status !== "NEEDS_REFUND" && attempt.status !== "REFUNDED") {
    return false;
  }
  const checkout = await getSetting("checkout", c.db);
  if (!checkout.receiptForRefundedPayments) return false;
  const [mismatch] = await c.db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.attemptId, attempt.id),
        eq(refunds.reason, "AMOUNT_MISMATCH"),
      ),
    )
    .limit(1);
  return !mismatch;
}

async function receiptInput(
  c: Ctx,
  attempt: PaymentAttempt,
  marker: string,
): Promise<IssueReceiptInput> {
  const [order] = await c.db
    .select()
    .from(orders)
    .where(eq(orders.id, attempt.orderId));
  if (!order) throw new NotFoundError("order", attempt.orderId);
  const profile = await getSetting("business_profile", c.db);
  const locale: Locale = order.locale;
  const text = LINE_TEXT[locale];
  const items = await c.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.createdAt));
  const itemized =
    attempt.amountMinor === order.totalMinor &&
    attempt.currency === order.currency;
  const lines: IssueReceiptInput["lines"] = itemized
    ? [
        ...items.map((i) => ({
          description: locale === "he" ? i.titleHe : i.titleEn,
          unitPriceMinor: i.priceMinor,
          quantity: 1 as const,
        })),
        ...(order.shippingMinor > 0
          ? [
              {
                description: text.shipping,
                unitPriceMinor: order.shippingMinor,
                quantity: 1 as const,
              },
            ]
          : []),
        ...(order.insuranceMinor > 0
          ? [
              {
                description: text.insurance,
                unitPriceMinor: order.insuranceMinor,
                quantity: 1 as const,
              },
            ]
          : []),
      ]
    : [
        {
          description: `${text.order} ${order.number}`,
          unitPriceMinor: attempt.amountMinor,
          quantity: 1,
        },
      ];
  const address = [
    order.shipLine1,
    order.shipLine2,
    order.shipCity,
    order.shipPostalCode,
    order.shipCountry,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    marker,
    orderNumber: order.number,
    vatMode: profile.vatMode,
    zeroRatedExport: order.shipCountry !== "IL",
    language: locale,
    currency: attempt.currency,
    client: {
      name: order.buyerName ?? order.shipName ?? order.number,
      country: order.shipCountry,
      ...(order.buyerVatId ? { taxId: order.buyerVatId } : {}),
      ...(order.buyerCompanyName
        ? { companyName: order.buyerCompanyName }
        : {}),
      ...(address ? { address } : {}),
    },
    lines,
    payment: {
      type: paymentTypeOf(attempt),
      amountMinor: attempt.amountMinor,
      date: jerusalemDateKey(
        attempt.finalizedAt ?? order.paidAt ?? attempt.updatedAt,
      ),
      reference:
        attempt.transactionId ??
        attempt.captureId ??
        attempt.providerRef ??
        attempt.id,
      ...(attempt.cardLast4 ? { last4: attempt.cardLast4 } : {}),
      ...(attempt.installments ? { installments: attempt.installments } : {}),
    },
  };
}

/** After a receipt is issued: email it (consent) or put "print the receipt" on the checklist. */
async function afterReceiptIssued(tx: Tx, doc: TaxDocument): Promise<void> {
  const [order] = await tx
    .select({
      id: orders.id,
      email: orders.buyerEmail,
      locale: orders.locale,
      consent: orders.receiptEmailConsent,
    })
    .from(orders)
    .where(eq(orders.id, doc.orderId));
  if (!order) return;
  if (order.consent && order.email) {
    await enqueueEmail(tx, {
      template: "receipt",
      to: order.email,
      locale: order.locale,
      refId: doc.id,
    });
    return;
  }
  await tx
    .update(shipments)
    .set({
      checklist: sql`${shipments.checklist} || '{"printReceipt": true}'::jsonb`,
    })
    .where(eq(shipments.orderId, doc.orderId));
}

export async function issueReceiptForAttempt(
  attemptId: string,
  deps: TaxDocDeps = {},
): Promise<ServiceResult<IssueOutcome>> {
  const c = ctxOf(deps);
  const [attempt] = await c.db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId));
  if (!attempt) throw new NotFoundError("payment_attempt", attemptId);

  const existing = await currentReceiptRow(c, attemptId);
  if (!existing && !(await receiptEligible(c, attempt))) {
    return withEffects({ kind: "skipped", reason: "not_eligible" });
  }
  const [order] = await c.db
    .select({ number: orders.number })
    .from(orders)
    .where(eq(orders.id, attempt.orderId));
  if (!order) throw new NotFoundError("order", attempt.orderId);
  const profile = await getSetting("business_profile", c.db);
  const kind = profile.vatMode === "OSEK_PATUR" ? "RECEIPT" : "INVOICE_RECEIPT";
  const marker = taxDocumentMarker(order.number, kind, attempt.seq);

  const row =
    existing ??
    (await claimNewRow(c, {
      orderId: attempt.orderId,
      attemptId: attempt.id,
      refundId: null,
      kind,
      marker,
    }));
  return runDocument(c, row, {
    issue: async (r) =>
      c.provider.issueReceipt(await receiptInput(c, attempt, r.marker)),
    afterIssued: afterReceiptIssued,
  });
}

async function currentReceiptRow(
  c: Ctx,
  attemptId: string,
): Promise<TaxDocument | undefined> {
  const rows = await c.db
    .select()
    .from(taxDocuments)
    .where(
      and(
        eq(taxDocuments.attemptId, attemptId),
        inArray(taxDocuments.kind, [...RECEIPT_KINDS]),
      ),
    )
    .orderBy(asc(taxDocuments.createdAt));
  // A FAILED row may be followed by a later one; prefer the live row.
  return rows.find((r) => r.status !== "FAILED") ?? rows[rows.length - 1];
}

// ---------------------------------------------------------------- credit notes

export async function issueCreditNoteForRefund(
  refundId: string,
  deps: TaxDocDeps = {},
): Promise<ServiceResult<IssueOutcome>> {
  const c = ctxOf(deps);
  const [refund] = await c.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, refundId));
  if (!refund) throw new NotFoundError("refund", refundId);

  const [existing] = await c.db
    .select()
    .from(taxDocuments)
    .where(
      and(
        eq(taxDocuments.refundId, refundId),
        eq(taxDocuments.kind, "CREDIT_NOTE"),
        ne(taxDocuments.status, "FAILED"),
      ),
    )
    .limit(1);
  if (
    !existing &&
    refund.status !== "SUCCEEDED" &&
    refund.status !== "MANUAL_DONE"
  ) {
    return withEffects({ kind: "skipped", reason: "not_eligible" });
  }

  const receipt = await currentReceiptRow(c, refund.attemptId);
  if (!receipt) {
    // The receipt job may not have run yet; if it ran and found nothing to document, neither is
    // there anything to credit.
    const [job] = await c.db
      .select({ status: outboxJobs.status })
      .from(outboxJobs)
      .where(eq(outboxJobs.dedupeKey, dedupeKeys.receipt(refund.attemptId)));
    if (job && (job.status === "PENDING" || job.status === "RUNNING")) {
      return withEffects({
        kind: "reschedule",
        delayMs: RECEIPT_WAIT_MS,
        reason: "receipt not issued yet",
      });
    }
    if (!job || job.status === "DONE") {
      return withEffects({ kind: "skipped", reason: "not_eligible" });
    }
  }
  if (
    !existing &&
    receipt &&
    (receipt.status === "ISSUING" || receipt.status === "UNKNOWN")
  ) {
    return withEffects({
      kind: "reschedule",
      delayMs: RECEIPT_WAIT_MS,
      reason: `receipt is ${receipt.status}`,
    });
  }

  const [order] = await c.db
    .select({ number: orders.number, locale: orders.locale })
    .from(orders)
    .where(eq(orders.id, refund.orderId));
  if (!order) throw new NotFoundError("order", refund.orderId);
  const siblings = await c.db
    .select({ id: refunds.id })
    .from(refunds)
    .where(eq(refunds.orderId, refund.orderId))
    .orderBy(asc(refunds.createdAt), asc(refunds.id));
  const n = siblings.findIndex((s) => s.id === refund.id) + 1;
  const marker = taxDocumentMarker(order.number, "CREDIT_NOTE", n);

  const row =
    existing ??
    (await claimNewRow(c, {
      orderId: refund.orderId,
      attemptId: refund.attemptId,
      refundId: refund.id,
      kind: "CREDIT_NOTE",
      marker,
      // The receipt ended FAILED / NEEDS_MANUAL (or its job died): document by hand.
      needsManual: receipt?.status !== "ISSUED",
    }));
  if (row.status === "NEEDS_MANUAL") {
    await alertNeedsManual(c.db, row, "receipt not issued");
    return withEffects({ kind: "needs_manual", taxDocumentId: row.id });
  }
  const original = receipt?.providerDocId;
  return runDocument(c, row, {
    issue: async (r) => {
      if (!original) {
        throw new TaxDocumentNeedsManualError(
          c.provider.id,
          "the receipt has no provider document id",
        );
      }
      return c.provider.issueCreditNote({
        marker: r.marker,
        originalProviderDocId: original,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        language: order.locale,
        reason: refund.reason,
      });
    },
  });
}

// ---------------------------------------------------------------- the exactly-once runner

async function claimNewRow(
  c: Ctx,
  i: {
    orderId: string;
    attemptId: string;
    refundId: string | null;
    kind: TaxDocument["kind"];
    marker: string;
    needsManual?: boolean;
  },
): Promise<TaxDocument> {
  const [inserted] = await c.db
    .insert(taxDocuments)
    .values({
      orderId: i.orderId,
      attemptId: i.attemptId,
      refundId: i.refundId,
      kind: i.kind,
      provider: TAXDOC_DB_PROVIDER[c.provider.id],
      status: i.needsManual ? "NEEDS_MANUAL" : "ISSUING",
      marker: i.marker,
      attempts: i.needsManual ? 0 : 1,
      lastAttemptAt: i.needsManual ? null : new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return Object.assign(inserted, { justClaimed: true });
  // Another worker inserted it first (marker or one-per-attempt/refund unique index).
  const [row] = await c.db
    .select()
    .from(taxDocuments)
    .where(eq(taxDocuments.marker, i.marker));
  if (row) return row;
  throw new Error(`tax document claim for ${i.marker} conflicted`);
}

type ClaimedRow = TaxDocument & { justClaimed?: boolean };

interface Runner {
  issue: (row: TaxDocument) => Promise<IssuedDocument>;
  afterIssued?: (tx: Tx, row: TaxDocument) => Promise<void>;
}

async function runDocument(
  c: Ctx,
  start: ClaimedRow,
  r: Runner,
): Promise<ServiceResult<IssueOutcome>> {
  let row: TaxDocument = start;
  const now = Date.now();
  switch (row.status) {
    case "ISSUED":
      return withEffects({ kind: "skipped", reason: "already_issued" });
    case "NEEDS_MANUAL":
      return withEffects({ kind: "needs_manual", taxDocumentId: row.id });
    case "FAILED":
      return withEffects({ kind: "failed", taxDocumentId: row.id });
    case "ISSUING": {
      if (start.justClaimed) return callProvider(c, row, r);
      const last = row.lastAttemptAt?.getTime() ?? 0;
      if (row.attempts === 0) {
        // Moved back to ISSUING by an admin retry: claim the call.
        const claimed = await claimCall(c, row, "ISSUING");
        return claimed
          ? callProvider(c, claimed, r)
          : withEffects(reschedule(CALL_LEASE_MS, "claimed elsewhere"));
      }
      if (now - last < CALL_LEASE_MS) {
        return withEffects(
          reschedule(CALL_LEASE_MS - (now - last), "call in flight"),
        );
      }
      // A worker died between the call and recording its result: the outcome is unknown.
      const moved = await moveTo(c, row, ["ISSUING"], "UNKNOWN", {
        attempts: 0,
        error: "call abandoned before a result was recorded",
      });
      if (!moved) return withEffects(reschedule(60_000, "row changed"));
      row = moved;
      return resolveUnknown(c, row, r);
    }
    case "UNKNOWN":
      return resolveUnknown(c, row, r);
  }
}

function reschedule(
  delayMs: number,
  reason: string,
): IssueOutcome & { kind: "reschedule" } {
  return { kind: "reschedule", delayMs: Math.max(1_000, delayMs), reason };
}

/** Conditional status move (row count checked through `transition`); null when the row changed. */
async function moveTo(
  c: Ctx,
  row: TaxDocument,
  from: TaxDocumentStatus[],
  to: TaxDocumentStatus,
  patch: Partial<typeof taxDocuments.$inferInsert>,
  after?: (tx: Tx, row: TaxDocument) => Promise<void>,
): Promise<TaxDocument | null> {
  try {
    return await withTx(
      async (tx) => {
        const moved = await transition(
          tx,
          "taxDocument",
          row.id,
          from,
          to,
          patch,
          "system",
          { where: sql`${taxDocuments.attempts} = ${row.attempts}` },
        );
        if (after) await after(tx, moved);
        return moved;
      },
      { db: c.db, name: `taxdoc.${to.toLowerCase()}` },
    );
  } catch (error) {
    if (error instanceof IllegalTransitionError) return null;
    throw error;
  }
}

/** ISSUING (admin retry) or UNKNOWN → ISSUING with a fresh claimed call. */
async function claimCall(
  c: Ctx,
  row: TaxDocument,
  from: "ISSUING" | "UNKNOWN",
): Promise<TaxDocument | null> {
  if (from === "UNKNOWN") {
    return moveTo(c, row, ["UNKNOWN"], "ISSUING", {
      attempts: 1,
      lastAttemptAt: new Date(),
      error: null,
    });
  }
  const [claimed] = await c.db
    .update(taxDocuments)
    .set({ attempts: 1, lastAttemptAt: new Date() })
    .where(
      and(
        eq(taxDocuments.id, row.id),
        eq(taxDocuments.status, "ISSUING"),
        eq(taxDocuments.attempts, 0),
      ),
    )
    .returning();
  return claimed ?? null;
}

async function callProvider(
  c: Ctx,
  row: TaxDocument,
  r: Runner,
): Promise<ServiceResult<IssueOutcome>> {
  let doc: IssuedDocument;
  try {
    doc = await r.issue(row);
  } catch (error) {
    return recordFailure(c, row, error);
  }
  return recordIssued(c, row, doc, r, ["ISSUING"]);
}

async function recordIssued(
  c: Ctx,
  row: TaxDocument,
  doc: IssuedDocument,
  r: Runner,
  from: TaxDocumentStatus[],
): Promise<ServiceResult<IssueOutcome>> {
  const typeCode = Number.parseInt(doc.docTypeCode, 10);
  const moved = await moveTo(
    c,
    row,
    from,
    "ISSUED",
    {
      providerDocId: doc.providerDocId,
      docNumber: doc.docNumber,
      docTypeCode: Number.isFinite(typeCode) ? typeCode : null,
      allocationNumber: doc.allocationNumber ?? null,
      docUrl: doc.url ?? null,
      issuedAt: new Date(doc.issuedAt),
      error: null,
    },
    r.afterIssued,
  );
  if (!moved) return withEffects(reschedule(60_000, "row changed"));
  const effects: Effects = r.afterIssued ? { outbox: true } : {};
  return withEffects(
    { kind: "issued", taxDocumentId: row.id, status: "ISSUED" },
    effects,
  );
}

function errorText(error: unknown): string {
  return (
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  ).slice(0, 2000);
}

async function alertNeedsManual(
  db: Db | Tx,
  row: TaxDocument,
  reason: string,
): Promise<void> {
  await raiseAlert(
    {
      severity: "WARNING",
      kind: "TAX_DOCUMENT_NEEDS_MANUAL",
      dedupeKey: `taxdoc-manual:${row.id}`,
      entity: "order",
      entityId: row.orderId,
      params: { marker: row.marker, kind: row.kind, reason },
    },
    db,
  );
}

async function recordFailure(
  c: Ctx,
  row: TaxDocument,
  error: unknown,
): Promise<ServiceResult<IssueOutcome>> {
  if (error instanceof TaxDocumentNeedsManualError) {
    const moved = await moveTo(
      c,
      row,
      ["ISSUING"],
      "NEEDS_MANUAL",
      { error: errorText(error) },
      (tx, m) => alertNeedsManual(tx, m, error.reason),
    );
    return moved
      ? withEffects({ kind: "needs_manual", taxDocumentId: row.id })
      : withEffects(reschedule(60_000, "row changed"));
  }
  if (
    error instanceof ProviderRejectedError ||
    error instanceof ProviderNotConfiguredError
  ) {
    const moved = await moveTo(
      c,
      row,
      ["ISSUING"],
      "FAILED",
      { error: errorText(error) },
      (tx, m) =>
        raiseAlert(
          {
            severity: "WARNING",
            kind: "TAX_DOCUMENT_FAILED",
            dedupeKey: `taxdoc-failed:${m.id}:${m.attempts}`,
            entity: "order",
            entityId: m.orderId,
            params: { marker: m.marker, kind: m.kind },
          },
          tx,
        ).then(() => undefined),
    );
    return moved
      ? withEffects({ kind: "failed", taxDocumentId: row.id })
      : withEffects(reschedule(60_000, "row changed"));
  }
  // Timeout, 5xx, garbled response or anything unexpected: the provider may have issued it.
  log.warn("taxdocs.issue_unknown", {
    taxDocumentId: row.id,
    error: error instanceof Error ? error.name : "unknown",
  });
  const moved = await moveTo(c, row, ["ISSUING"], "UNKNOWN", {
    attempts: 0,
    lastAttemptAt: new Date(),
    error: errorText(error),
  });
  return withEffects(
    moved
      ? reschedule(UNKNOWN_RETRY_MS, "outcome unknown; search by marker first")
      : reschedule(60_000, "row changed"),
  );
}

async function resolveUnknown(
  c: Ctx,
  row: TaxDocument,
  r: Runner,
): Promise<ServiceResult<IssueOutcome>> {
  const since = Date.now() - (row.lastAttemptAt?.getTime() ?? 0);
  if (since < UNKNOWN_RETRY_MS) {
    return withEffects(reschedule(UNKNOWN_RETRY_MS - since, "unknown: wait"));
  }
  let found: IssuedDocument | null;
  try {
    if (!c.provider.findByMarker) {
      throw new Error("the provider cannot search by marker");
    }
    found = await c.provider.findByMarker(row.marker, row.createdAt);
  } catch (error) {
    const searches = row.attempts + 1;
    if (searches >= MAX_INCONCLUSIVE_SEARCHES || !c.provider.findByMarker) {
      const moved = await moveTo(
        c,
        row,
        ["UNKNOWN"],
        "NEEDS_MANUAL",
        { attempts: searches, error: errorText(error) },
        (tx, m) => alertNeedsManual(tx, m, "marker search inconclusive"),
      );
      return moved
        ? withEffects({ kind: "needs_manual", taxDocumentId: row.id })
        : withEffects(reschedule(60_000, "row changed"));
    }
    const [updated] = await c.db
      .update(taxDocuments)
      .set({
        attempts: searches,
        lastAttemptAt: new Date(),
        error: errorText(error),
      })
      .where(
        and(
          eq(taxDocuments.id, row.id),
          eq(taxDocuments.status, "UNKNOWN"),
          eq(taxDocuments.attempts, row.attempts),
        ),
      )
      .returning({ id: taxDocuments.id });
    return withEffects(
      reschedule(
        updated ? UNKNOWN_RETRY_MS : 60_000,
        `marker search inconclusive (${searches}/${MAX_INCONCLUSIVE_SEARCHES})`,
      ),
    );
  }
  if (found) return recordIssued(c, row, found, r, ["UNKNOWN"]);
  // Confirmed absent: issue again under a fresh claim.
  const claimed = await claimCall(c, row, "UNKNOWN");
  if (!claimed) return withEffects(reschedule(60_000, "row changed"));
  return callProvider(c, claimed, r);
}

// ---------------------------------------------------------------- reads (order page, admin, print)

/** Tax documents of an order, oldest first. */
export async function listTaxDocumentsForOrder(
  orderId: string,
  db: Db = defaultDb,
): Promise<TaxDocument[]> {
  return db
    .select()
    .from(taxDocuments)
    .where(eq(taxDocuments.orderId, orderId))
    .orderBy(asc(taxDocuments.createdAt));
}
