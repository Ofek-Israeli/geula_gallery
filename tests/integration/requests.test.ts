import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach, testDatabaseUrl } from "../helpers/db";
import { adminCtx, insertRequest } from "../helpers/factories/admin";
import { insertArtwork, uniqueBuyer } from "../helpers/factories/core";
import { createMailbox } from "../helpers/mailbox";

/**
 * Buyer requests (spec §5.8, §3.6 "Buyer request"): a question or quote request stores the row and
 * sends `request-ack` (buyer, their language) and `painter-new-request` (Hebrew); replies are
 * emailed once each with `request-reply`; quotes and offers can be declined; questions closed;
 * "Send quote" goes through `createLinkOrder` (WS2).
 */
const { db } = await import("@/server/db/client");
const { buyerRequests, outboxJobs } = await import("@/server/db/schema");
const svc = await import("@/server/requests/service");
const { processOutbox } = await import("@/server/outbox/process");
const { getSetting } = await import("@/server/settings");
const { NotImplementedError } = await import("@/server/domain/errors");

const ctx = adminCtx();
const mailbox = createMailbox(testDatabaseUrl());
cleanDatabaseBeforeEach();

async function drain() {
  for (let i = 0; i < 3; i++) await processOutbox({ limit: 50 });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return "ok";
}

describe("submitRequest", () => {
  it("stores a question and emails the buyer (their locale) and the painter (Hebrew)", async () => {
    const a = await insertArtwork(db, {
      titleEn: "Blue Hour",
      titleHe: "שעה כחולה",
    });
    const buyer = uniqueBuyer("q");
    const { result, effects } = await svc.submitRequest(
      {
        kind: "QUESTION",
        artworkSlug: a.slug,
        name: buyer.name,
        email: buyer.email,
        message: "Does it come framed?",
        locale: "en",
      },
      { ipHash: "ip-hash" },
    );
    expect(effects.outbox).toBe(true);
    const [row] = await db
      .select()
      .from(buyerRequests)
      .where(eq(buyerRequests.id, result.requestId));
    expect(row).toMatchObject({
      kind: "QUESTION",
      status: "NEW",
      artworkId: a.id,
      ipHash: "ip-hash",
    });
    await drain();
    const ack = await mailbox.latest({
      template: "request-ack",
      to: buyer.email,
    });
    expect(ack?.locale).toBe("en");
    expect(ack?.subject).toContain("Blue Hour");
    expect(ack?.text).toContain("Does it come framed?");
    const painter = await getSetting("business_profile");
    const note = await mailbox.latest({
      template: "painter-new-request",
      to: painter.notificationEmail,
    });
    expect(note?.locale).toBe("he");
    expect(note?.html).toContain(`/he/admin/inbox/${result.requestId}`);
  });

  it("refuses quotes for sold or unpublished works, and offers (Tier B)", async () => {
    const sold = await insertArtwork(db, {
      saleStatus: "SOLD",
      soldAt: new Date(),
    });
    const draft = await insertArtwork(db, {
      isPublished: false,
      publishedAt: null,
    });
    const base = {
      name: "A",
      email: "a@example.test",
      message: "",
      locale: "he" as const,
    };
    expect(
      await code(
        svc.submitRequest(
          { ...base, kind: "QUOTE", artworkSlug: sold.slug },
          { ipHash: null },
        ),
      ),
    ).toBe("NOT_REQUESTABLE");
    expect(
      await code(
        svc.submitRequest(
          { ...base, kind: "QUESTION", artworkSlug: draft.slug },
          { ipHash: null },
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        svc.submitRequest(
          { ...base, kind: "OFFER", artworkSlug: sold.slug },
          { ipHash: null },
        ),
      ),
    ).toBe("NOT_REQUESTABLE");
    // A general question without a work is fine (the contact page).
    expect(
      await code(
        svc.submitRequest(
          { ...base, kind: "QUESTION", topic: "COMMISSION", message: "hi" },
          { ipHash: null },
        ),
      ),
    ).toBe("ok");
  });
});

describe("inbox", () => {
  it("a reply moves a question to REPLIED and each reply is its own email", async () => {
    const r = await insertRequest(db, { locale: "he" });
    const first = await svc.replyToRequest(ctx, r.id, "כן, היא זמינה.");
    expect(first.result.status).toBe("REPLIED");
    await svc.replyToRequest(ctx, r.id, "ועוד פרט.");
    const jobs = await db
      .select({ key: outboxJobs.dedupeKey })
      .from(outboxJobs);
    expect(
      jobs.filter((j) => j.key.startsWith(`email:request-reply:${r.id}:`)),
    ).toHaveLength(2);
    await drain();
    const sent = await mailbox.list({ template: "request-reply", to: r.email });
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.locale === "he")).toBe(true);
    await svc.closeRequest(ctx, r.id);
    const [row] = await db
      .select()
      .from(buyerRequests)
      .where(eq(buyerRequests.id, r.id));
    expect(row?.status).toBe("CLOSED");
    expect(await code(svc.replyToRequest(ctx, r.id, "  "))).toBe(
      "REPLY_REQUIRED",
    );
  });

  it("a quote request can be declined with a message; a question cannot be declined", async () => {
    const a = await insertArtwork(db);
    const q = await insertRequest(db, {
      kind: "QUOTE",
      artworkId: a.id,
      country: "US",
    });
    await svc.declineRequest(ctx, q.id, "Sorry, not shipping there.");
    const [row] = await db
      .select()
      .from(buyerRequests)
      .where(eq(buyerRequests.id, q.id));
    expect(row).toMatchObject({
      status: "DECLINED",
      adminReply: "Sorry, not shipping there.",
    });
    const question = await insertRequest(db);
    expect(await code(svc.declineRequest(ctx, question.id, null))).toBe(
      "NOT_DECLINABLE",
    );
  });

  it("lists open requests and the conversation history of an address", async () => {
    const a = await insertRequest(db, { email: "same@example.test" });
    const b = await insertRequest(db, {
      email: "SAME@example.test",
      kind: "QUOTE",
    });
    const list = await svc.listRequests(ctx, { filter: "open" });
    expect(list.total).toBe(2);
    const detail = await svc.getRequest(ctx, b.id);
    expect(detail?.history.map((h) => h.id)).toEqual([a.id]);
    expect(await svc.countOpenRequests()).toBe(2);
  });

  it("send quote validates the request, then calls createLinkOrder (WS2)", async (t) => {
    const question = await insertRequest(db);
    const input = {
      buyer: { name: "B", email: "b@example.test", phone: "" },
      country: "IL",
      currency: "ILS" as const,
      itemPriceMinor: 100_000,
      shippingMethod: "QUOTED" as const,
      lockedShippingMinor: 10_000,
    };
    expect(await code(svc.sendQuote(ctx, question.id, input))).toBe(
      "NOT_QUOTABLE",
    );
    const a = await insertArtwork(db);
    const q = await insertRequest(db, {
      kind: "QUOTE",
      artworkId: a.id,
      country: "IL",
    });
    expect(
      await code(svc.sendQuote(ctx, q.id, { ...input, currency: "USD" })),
    ).toBe("IL_REQUIRES_ILS");
    try {
      const out = await svc.sendQuote(ctx, q.id, input);
      const [row] = await db
        .select()
        .from(buyerRequests)
        .where(eq(buyerRequests.id, q.id));
      expect(row?.status).toBe("QUOTED");
      expect(row?.orderId).toBe(out.result.orderId);
    } catch (error) {
      // createLinkOrder is a WS2 stub until M4 integration.
      if (error instanceof NotImplementedError) t.skip();
      throw error;
    }
  });
});
