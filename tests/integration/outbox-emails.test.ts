import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import {
  buyableArtwork,
  clickMockPay,
  execSql,
  heldOrder,
} from "../helpers/factories/commerce";
import { createMailbox } from "../helpers/mailbox";

/**
 * The SEND_EMAIL handler over the M2 flows (spec §5.4): order-confirmation in the buyer's locale
 * with the inline disclosure summary and link (sets disclosure_sent_at once), painter-new-order in
 * Hebrew, purchase-not-completed / payment-review / refund-issued with fresh data, and exactly one
 * send per dedupe key even when a job runs twice.
 */
const { db } = await import("@/server/db/client");
const { emailMessages, orders, outboxJobs } = await import(
  "@/server/db/schema"
);
const { finalizeAttempt } = await import("@/server/payments/finalize");
const { processOutbox } = await import("@/server/outbox/process");
const { sendEmailHandler } = await import(
  "@/server/outbox/handlers/send-email"
);
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { resetMockTaxDocHooks } = await import("@/server/taxdocs/mock");
const { testDatabaseUrl } = await import("../helpers/db");

const mailbox = createMailbox(testDatabaseUrl());

cleanDatabaseBeforeEach();
beforeEach(() => {
  resetMockProviderHooks();
  resetMockTaxDocHooks({ forget: true });
});

async function paid(locale: "he" | "en" = "en") {
  const art = await buyableArtwork(db);
  const h = await heldOrder(art.slug, { locale });
  await clickMockPay(h.ref, "pay");
  await finalizeAttempt(h.attemptId, { trigger: "return" });
  return { ...h, art };
}

async function drain() {
  for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
}

describe("order-confirmation and painter-new-order", () => {
  it("are sent once, in the right locales, with the disclosure summary", async () => {
    const h = await paid("en");
    await drain();
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    const confirmation = await mailbox.latest({
      template: "order-confirmation",
      orderId: h.orderId,
    });
    expect(confirmation).toMatchObject({
      status: "SENT",
      locale: "en",
      toEmail: h.input.buyer.email,
    });
    expect(confirmation?.subject).toBe(`Order ${order?.number} is confirmed`);
    expect(confirmation?.html).toContain('dir="ltr"');
    expect(confirmation?.text).toMatch(/disclosure document – summary/i);
    expect(confirmation?.text).toContain(`Order ${order?.number}`);
    // The disclosure summary names the seller with the ID number (allowed in emails, spec §1.2).
    expect(confirmation?.text).toContain("Seller:");
    expect(confirmation?.html).toContain(
      `/en/print/disclosure/${order?.number}?k=`,
    );
    expect(order?.disclosureSentAt).toBeInstanceOf(Date);
    expect(order?.disclosureVersion).toBeTruthy();

    const painter = await mailbox.latest({
      template: "painter-new-order",
      orderId: h.orderId,
    });
    expect(painter).toMatchObject({ status: "SENT", locale: "he" });
    expect(painter?.html).toContain('dir="rtl"');
    expect(painter?.html).toContain(`/he/admin/orders/${h.orderId}`);
  });

  it("a job that runs twice sends once and keeps the first disclosure time", async () => {
    const h = await paid("he");
    await drain();
    const [before] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    const [job] = await db
      .select()
      .from(outboxJobs)
      .where(
        eq(
          outboxJobs.dedupeKey,
          `email:order-confirmation:${h.orderId}:${h.input.buyer.email.toLowerCase()}`,
        ),
      );
    expect(job?.status).toBe("DONE");
    await sendEmailHandler(
      job?.payload as Parameters<typeof sendEmailHandler>[0],
      { jobId: Number(job?.id), attempts: 2, dedupeKey: job?.dedupeKey ?? "" },
    );
    const sent = await mailbox.list({
      template: "order-confirmation",
      orderId: h.orderId,
    });
    expect(sent).toHaveLength(1);
    const [after] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, h.orderId));
    expect(after?.disclosureSentAt?.getTime()).toBe(
      before?.disclosureSentAt?.getTime(),
    );
  });
});

describe("other commerce emails", () => {
  it("payment-review and purchase-not-completed render from the attempt", async () => {
    const art = await buyableArtwork(db);
    const h = await heldOrder(art.slug, { locale: "en" });
    await clickMockPay(h.ref, "cancel");
    // Arrange: a lost-before-capture notice and a review notice for this attempt.
    const { enqueueEmail } = await import("@/server/outbox/enqueue");
    await enqueueEmail(db, {
      template: "purchase-not-completed",
      to: h.input.buyer.email,
      locale: "en",
      refId: h.attemptId,
    });
    await enqueueEmail(db, {
      template: "payment-review",
      to: h.input.buyer.email,
      locale: "en",
      refId: h.attemptId,
    });
    await drain();
    const lost = await mailbox.latest({ template: "purchase-not-completed" });
    expect(lost?.status).toBe("SENT");
    expect(lost?.text).toContain("You were not charged.");
    const review = await mailbox.latest({ template: "payment-review" });
    expect(review?.status).toBe("SENT");
    expect(review?.subject).toContain("is being reviewed");
  });

  it("refund-issued follows a settled refund", async () => {
    const h = await paid("en");
    await drain();
    const { requestRefund } = await import("@/server/payments/refunds");
    const [{ amount }] = (
      await execSql(
        "SELECT amount_minor AS amount FROM payment_attempts WHERE id = $1",
        [h.attemptId],
      )
    ).rows as [{ amount: number }];
    await requestRefund({
      attemptId: h.attemptId,
      amountMinor: amount,
      reason: "ADMIN",
      requestedBy: "admin:test",
    });
    await drain();
    const mail = await mailbox.latest({ template: "refund-issued" });
    expect(mail?.status).toBe("SENT");
    expect(mail?.text).toContain("We sent a refund of");
  });

  it("templates owned by later streams fail loudly instead of sending a stub", async () => {
    const { enqueueEmail } = await import("@/server/outbox/enqueue");
    await enqueueEmail(db, {
      template: "request-ack",
      to: "someone@example.test",
      locale: "en",
      refId: crypto.randomUUID(),
    });
    const stats = await processOutbox({ limit: 5 });
    expect(stats.retried).toBe(1);
    expect(
      await db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.template, "request-ack")),
    ).toHaveLength(0);
  });
});
