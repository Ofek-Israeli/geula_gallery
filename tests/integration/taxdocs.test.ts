import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
  patchSetting,
} from "../helpers/factories/commerce";

/**
 * Spec §10.3 `taxdocs` (M2 part: mock mode) and §4.3 "Exactly once": receipts for captured
 * payments, the claim row before the call, UNKNOWN resolved by a marker search first, three
 * inconclusive searches → NEEDS_MANUAL, a clear refusal → FAILED, receipts for NEEDS_REFUND
 * payments (not AMOUNT_MISMATCH; switchable), and credit notes that wait for their receipt.
 */
const { db } = await import("@/server/db/client");
const { adminAlerts, paymentAttempts, refunds, shipments, taxDocuments } =
  await import("@/server/db/schema");
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { issueReceiptForAttempt, issueCreditNoteForRefund, UNKNOWN_RETRY_MS } =
  await import("@/server/taxdocs/issue");
const { mockTaxDocHooks, resetMockTaxDocHooks } = await import(
  "@/server/taxdocs/mock"
);
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { requestRefund, executeRefund, settleRefund } = await import(
  "@/server/payments/refunds"
);
const { processOutbox } = await import("@/server/outbox/process");

cleanDatabaseBeforeEach();
beforeEach(() => {
  resetMockProviderHooks();
  resetMockTaxDocHooks({ forget: true });
});

async function paidOrder(opts: { method?: "CARRIER_TABLE" } = {}) {
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug, opts);
  await clickMockPay(h.ref, "pay");
  const { result } = await finalizeAttempt(h.attemptId, { trigger: "return" });
  expect(result.outcome).toBe("paid");
  return h;
}

async function docsOf(attemptId: string) {
  return db
    .select()
    .from(taxDocuments)
    .where(eq(taxDocuments.attemptId, attemptId));
}

/** Pretend the last provider interaction happened `ms` ago. */
async function age(taxDocumentId: string, ms: number) {
  await execSql(
    "UPDATE tax_documents SET last_attempt_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1",
    [taxDocumentId, String(ms)],
  );
}

describe("receipts (mock mode)", () => {
  it("a paid attempt gets exactly one receipt; a re-run is a no-op", async () => {
    const h = await paidOrder();
    const first = await issueReceiptForAttempt(h.attemptId);
    expect(first.result.kind).toBe("issued");
    const [doc] = await docsOf(h.attemptId);
    expect(doc).toMatchObject({
      status: "ISSUED",
      provider: "MOCK",
      kind: "RECEIPT",
      docTypeCode: 400,
      attempts: 1,
    });
    expect(doc?.marker).toMatch(/^GG-[0-9A-Z]{6}\/RECEIPT\/1$/);
    expect(doc?.docNumber).toMatch(/^DEMO-[0-9A-Z]{6}-R1$/);
    const again = await issueReceiptForAttempt(h.attemptId);
    expect(again.result).toEqual({ kind: "skipped", reason: "already_issued" });
    expect(mockTaxDocHooks.calls.issue).toBe(1);
    expect(await docsOf(h.attemptId)).toHaveLength(1);
  });

  it("osek murshe issues a tax invoice-receipt (320)", async () => {
    await patchSetting("business_profile", { vatMode: "OSEK_MURSHE" });
    const h = await paidOrder();
    await issueReceiptForAttempt(h.attemptId);
    const [doc] = await docsOf(h.attemptId);
    expect(doc).toMatchObject({ kind: "INVOICE_RECEIPT", docTypeCode: 320 });
  });

  it("the outbox job issues the receipt and emails it (consent given)", async () => {
    const h = await paidOrder();
    await processOutbox({ limit: 20 }); // confirmation emails + receipt (enqueues its email)
    await processOutbox({ limit: 20 }); // the receipt email
    const [doc] = await docsOf(h.attemptId);
    expect(doc?.status).toBe("ISSUED");
    const { emailMessages } = await import("@/server/db/schema");
    const mails = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.template, "receipt"));
    expect(mails).toHaveLength(1);
    expect(mails[0]?.status).toBe("SENT");
  });

  it("without email consent, 'print the receipt' goes on the shipment checklist", async () => {
    const h = await paidOrder();
    await execSql(
      "UPDATE orders SET receipt_email_consent = false WHERE id = $1",
      [h.orderId],
    );
    await issueReceiptForAttempt(h.attemptId);
    const [s] = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, h.orderId));
    expect(s?.checklist).toMatchObject({ printReceipt: true });
  });

  it("timeout after issuing → UNKNOWN → waits ≥ 5 min → found by marker (no second issue call)", async () => {
    const h = await paidOrder();
    mockTaxDocHooks.issueTimeout = { applied: true };
    const r1 = await issueReceiptForAttempt(h.attemptId);
    expect(r1.result).toMatchObject({
      kind: "reschedule",
      delayMs: UNKNOWN_RETRY_MS,
    });
    const [doc] = await docsOf(h.attemptId);
    expect(doc?.status).toBe("UNKNOWN");
    // Too early: no search yet.
    const r2 = await issueReceiptForAttempt(h.attemptId);
    expect(r2.result.kind).toBe("reschedule");
    expect(mockTaxDocHooks.calls.search).toBe(0);
    await age(doc?.id ?? "", UNKNOWN_RETRY_MS + 1000);
    const r3 = await issueReceiptForAttempt(h.attemptId);
    expect(r3.result.kind).toBe("issued");
    expect(mockTaxDocHooks.calls).toEqual({ issue: 1, search: 1 });
    expect((await docsOf(h.attemptId))[0]?.status).toBe("ISSUED");
  });

  it("timeout without effect → confirmed absent → issued again under a new claim", async () => {
    const h = await paidOrder();
    mockTaxDocHooks.issueTimeout = { applied: false };
    await issueReceiptForAttempt(h.attemptId);
    const [doc] = await docsOf(h.attemptId);
    await age(doc?.id ?? "", UNKNOWN_RETRY_MS + 1000);
    const r = await issueReceiptForAttempt(h.attemptId);
    expect(r.result.kind).toBe("issued");
    expect(mockTaxDocHooks.calls).toEqual({ issue: 2, search: 1 });
  });

  it("three inconclusive searches → NEEDS_MANUAL with an alert", async () => {
    const h = await paidOrder();
    mockTaxDocHooks.issueTimeout = { applied: false };
    mockTaxDocHooks.searchInconclusive = 3;
    await issueReceiptForAttempt(h.attemptId);
    const [doc] = await docsOf(h.attemptId);
    const id = doc?.id ?? "";
    for (let i = 1; i <= 2; i++) {
      await age(id, UNKNOWN_RETRY_MS + 1000);
      const r = await issueReceiptForAttempt(h.attemptId);
      expect(r.result.kind).toBe("reschedule");
    }
    await age(id, UNKNOWN_RETRY_MS + 1000);
    const last = await issueReceiptForAttempt(h.attemptId);
    expect(last.result.kind).toBe("needs_manual");
    expect((await docsOf(h.attemptId))[0]?.status).toBe("NEEDS_MANUAL");
    const alerts = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "TAX_DOCUMENT_NEEDS_MANUAL"));
    expect(alerts).toHaveLength(1);
    expect(mockTaxDocHooks.calls.issue).toBe(1);
  });

  it("a clear refusal → FAILED with an alert; the job does not retry by itself", async () => {
    const h = await paidOrder();
    mockTaxDocHooks.issueReject = true;
    const r = await issueReceiptForAttempt(h.attemptId);
    expect(r.result.kind).toBe("failed");
    expect((await docsOf(h.attemptId))[0]?.status).toBe("FAILED");
    expect(
      await db
        .select()
        .from(adminAlerts)
        .where(eq(adminAlerts.kind, "TAX_DOCUMENT_FAILED")),
    ).toHaveLength(1);
    const again = await issueReceiptForAttempt(h.attemptId);
    expect(again.result.kind).toBe("failed");
    expect(mockTaxDocHooks.calls.issue).toBe(1);
  });

  it("a worker that died mid-call leaves an ISSUING row that is resolved as UNKNOWN", async () => {
    const h = await paidOrder();
    await issueReceiptForAttempt(h.attemptId);
    // Simulate the crash: the row never left ISSUING and its call is long past.
    const [doc] = await docsOf(h.attemptId);
    await execSql(
      "UPDATE tax_documents SET status = 'ISSUING', provider_doc_id = NULL, doc_number = NULL, last_attempt_at = now() - interval '10 minutes' WHERE id = $1",
      [doc?.id],
    );
    // Abandoned call → UNKNOWN; its last call is > 5 min old, so the marker search runs at once
    // and finds the document the dead worker had issued.
    const r1 = await issueReceiptForAttempt(h.attemptId);
    expect(r1.result.kind).toBe("issued");
    expect(mockTaxDocHooks.calls.search).toBe(1);
    expect(mockTaxDocHooks.calls.issue).toBe(1);
    expect((await docsOf(h.attemptId))[0]?.status).toBe("ISSUED");
  });
});

describe("which payments get a receipt", () => {
  async function capturedButUnapplied() {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    await clickMockPay(h.ref, "pay");
    await execSql(
      "UPDATE payment_attempts SET status = 'NEEDS_REFUND' WHERE id = $1",
      [h.attemptId],
    );
    return h;
  }

  it("a NEEDS_REFUND payment gets a receipt", async () => {
    const h = await capturedButUnapplied();
    expect((await issueReceiptForAttempt(h.attemptId)).result.kind).toBe(
      "issued",
    );
  });

  it("…unless the accountant switched it off", async () => {
    await patchSetting("checkout", { receiptForRefundedPayments: false });
    const h = await capturedButUnapplied();
    expect((await issueReceiptForAttempt(h.attemptId)).result).toEqual({
      kind: "skipped",
      reason: "not_eligible",
    });
  });

  it("an AMOUNT_MISMATCH payment never gets one", async () => {
    const h = await capturedButUnapplied();
    const [a] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    await db.insert(refunds).values({
      attemptId: h.attemptId,
      orderId: h.orderId,
      amountMinor: a?.amountMinor ?? 1,
      currency: a?.currency ?? "ILS",
      reason: "AMOUNT_MISMATCH",
      status: "MANUAL_REQUIRED",
      idemKey: crypto.randomUUID(),
      requestedBy: "system",
    });
    expect((await issueReceiptForAttempt(h.attemptId)).result.kind).toBe(
      "skipped",
    );
  });

  it("an attempt that never captured gets none", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug);
    expect((await issueReceiptForAttempt(h.attemptId)).result.kind).toBe(
      "skipped",
    );
  });
});

describe("credit notes", () => {
  async function settledRefund(h: { attemptId: string }) {
    const [a] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    const { result } = await requestRefund({
      attemptId: h.attemptId,
      amountMinor: a?.amountMinor ?? 0,
      reason: "ADMIN",
      requestedBy: "admin:test",
    });
    expect((await executeRefund(result.refundId)).result.status).toBe(
      "SUCCEEDED",
    );
    await settleRefund(result.refundId);
    return result.refundId;
  }

  it("a settled refund of a receipted payment gets a credit note linked to the receipt", async () => {
    const h = await paidOrder();
    await issueReceiptForAttempt(h.attemptId);
    const refundId = await settledRefund(h);
    const r = await issueCreditNoteForRefund(refundId);
    expect(r.result.kind).toBe("issued");
    const [note] = await db
      .select()
      .from(taxDocuments)
      .where(
        and(
          eq(taxDocuments.refundId, refundId),
          eq(taxDocuments.kind, "CREDIT_NOTE"),
        ),
      );
    expect(note).toMatchObject({ status: "ISSUED", docTypeCode: 330 });
    expect(note?.docNumber).toMatch(/^DEMO-[0-9A-Z]{6}-C1$/);
    expect((await issueCreditNoteForRefund(refundId)).result.kind).toBe(
      "skipped",
    );
  });

  it("reschedules while the receipt is UNKNOWN, then issues", async () => {
    const h = await paidOrder();
    mockTaxDocHooks.issueTimeout = { applied: true };
    await issueReceiptForAttempt(h.attemptId);
    const refundId = await settledRefund(h);
    expect((await issueCreditNoteForRefund(refundId)).result.kind).toBe(
      "reschedule",
    );
    const [receipt] = await docsOf(h.attemptId);
    await age(receipt?.id ?? "", UNKNOWN_RETRY_MS + 1000);
    await issueReceiptForAttempt(h.attemptId);
    expect((await issueCreditNoteForRefund(refundId)).result.kind).toBe(
      "issued",
    );
  });

  it("becomes NEEDS_MANUAL when the receipt FAILED", async () => {
    const h = await paidOrder();
    mockTaxDocHooks.issueReject = true;
    await issueReceiptForAttempt(h.attemptId);
    const refundId = await settledRefund(h);
    const r = await issueCreditNoteForRefund(refundId);
    expect(r.result.kind).toBe("needs_manual");
  });

  it("the REFUND_SETTLED → ISSUE_CREDIT_NOTE chain runs through the outbox", async () => {
    const h = await paidOrder();
    await processOutbox({ limit: 20 }); // receipt + emails
    const [a] = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, h.attemptId));
    await requestRefund({
      attemptId: h.attemptId,
      amountMinor: a?.amountMinor ?? 0,
      reason: "ADMIN",
      requestedBy: "admin:test",
    });
    for (let i = 0; i < 4; i++) await processOutbox({ limit: 20 });
    const notes = await db
      .select()
      .from(taxDocuments)
      .where(eq(taxDocuments.kind, "CREDIT_NOTE"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.status).toBe("ISSUED");
  });
});

const { taxDocumentProvider } = await import("@/server/taxdocs/registry");

describe("modes: gateway and none (spec §4.3 Modes)", () => {
  const gateway = taxDocumentProvider({ mode: "gateway" });
  const none = taxDocumentProvider({ mode: "none" });

  it("gateway: the receipt is copied from the document Cardcom issued with the charge", async () => {
    const h = await paidOrder();
    await execSql(
      `UPDATE payment_attempts SET provider = 'CARDCOM', provider_mode = 'TEST',
         verified_raw = $2::jsonb WHERE id = $1`,
      [
        h.attemptId,
        JSON.stringify({
          gatewayDocument: {
            type: "TaxInvoiceAndReceipt",
            number: "CC-55012",
            url: "https://example.test/doc/55012",
          },
        }),
      ],
    );
    const { result } = await issueReceiptForAttempt(h.attemptId, {
      provider: gateway,
    });
    expect(result.kind).toBe("issued");
    const [doc] = await docsOf(h.attemptId);
    expect(doc).toMatchObject({
      status: "ISSUED",
      provider: "CARDCOM_GATEWAY",
      docNumber: "CC-55012",
      docUrl: "https://example.test/doc/55012",
    });
  });

  it("gateway: a payment without a gateway document (PayPal, offline) needs the accountant", async () => {
    const h = await paidOrder();
    await execSql(
      "UPDATE payment_attempts SET provider = 'PAYPAL', provider_mode = 'TEST' WHERE id = $1",
      [h.attemptId],
    );
    const { result } = await issueReceiptForAttempt(h.attemptId, {
      provider: gateway,
    });
    expect(result.kind).toBe("needs_manual");
    const alerts = await db
      .select()
      .from(adminAlerts)
      .where(eq(adminAlerts.kind, "TAX_DOCUMENT_NEEDS_MANUAL"));
    expect(alerts).toHaveLength(1);
  });

  it("none: every receipt is NEEDS_MANUAL (demo deployments only)", async () => {
    const h = await paidOrder();
    const { result } = await issueReceiptForAttempt(h.attemptId, {
      provider: none,
    });
    expect(result.kind).toBe("needs_manual");
    const [doc] = await docsOf(h.attemptId);
    expect(doc?.status).toBe("NEEDS_MANUAL");
  });
});
