import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  cleanDatabaseBeforeEach,
  testDatabaseUrl,
  testEnv,
} from "../helpers/db";
import {
  buyableArtwork,
  completeDetails,
  linkOrder,
  testAdminContext,
} from "../helpers/factories/commerce";
import { insertArtwork, uniqueBuyer } from "../helpers/factories/core";
import { createMailbox } from "../helpers/mailbox";

/**
 * The showcase launch (docs/architecture.md "Showcase launch"):
 * - `SALES_OPEN=false`: the checkout quote is blocked with SALES_CLOSED (the page keeps the work
 *   and its "Ask"), and no payment link can be created or paid;
 * - `EMAIL_TO_VISITORS=false` (set for this whole file, before the app is imported): visitor and
 *   buyer emails finish without sending, the painter's still go out (with the visitor's phone);
 * - "Mark as answered" records an answer given by phone or WhatsApp, without an email.
 */
process.env.EMAIL_TO_VISITORS = "false";

const { db } = await import("@/server/db/client");
const { auditLog, buyerRequests, orders, outboxJobs } = await import(
  "@/server/db/schema"
);
const { parseEnv } = await import("@/server/env");
const { getCheckoutQuote } = await import("@/server/checkout/quote");
const { createLinkOrder } = await import("@/server/checkout/links");
const { startPaymentForOrder } = await import("@/server/checkout/start");
const svc = await import("@/server/requests/service");
const { processOutbox } = await import("@/server/outbox/process");
const { getSetting } = await import("@/server/settings");

const closed = parseEnv({ ...testEnv(), SALES_OPEN: "false" });
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

describe("online sales closed (SALES_OPEN=false)", () => {
  it("blocks the checkout quote with SALES_CLOSED, keeping the work for the page", async () => {
    const art = await buyableArtwork(db);
    const one = await getCheckoutQuote(
      { slug: art.slug, locale: "en", country: "IL" },
      { env: closed },
    );
    expect(one).toEqual({
      kind: "blocked",
      reason: "SALES_CLOSED",
      artworkId: art.id,
      problems: [],
    });
    const cart = await getCheckoutQuote(
      { artworkIds: [art.id], locale: "en", country: "IL" },
      { env: closed },
    );
    expect(cart).toMatchObject({ kind: "blocked", reason: "SALES_CLOSED" });
    // An unknown work is still a 404, and an open store still quotes.
    expect(
      await getCheckoutQuote(
        { slug: "no-such-work", locale: "en", country: "IL" },
        { env: closed },
      ),
    ).toMatchObject({ reason: "NOT_AVAILABLE", artworkId: null });
    expect(
      (await getCheckoutQuote({ slug: art.slug, locale: "en", country: "IL" }))
        .kind,
    ).toBe("ok");
  });

  it("creates no payment link (quotes, offers, manual orders)", async () => {
    const art = await buyableArtwork(db);
    const buyer = uniqueBuyer("closed");
    expect(
      await code(
        createLinkOrder(
          {
            kind: "MANUAL",
            artworkId: art.id,
            buyer: { name: buyer.name, email: buyer.email, phone: "" },
            country: "IL",
            currency: "ILS",
            itemPriceMinor: art.priceIlsMinor ?? 100_000,
            shippingMethod: "LOCAL_PICKUP",
            conversationTookPlace: true,
            locale: "en",
          },
          testAdminContext(),
          { env: closed },
        ),
      ),
    ).toBe("SALES_CLOSED");
    expect(await db.select().from(orders)).toEqual([]);
  });

  it("refuses to pay a link order made while sales were open", async () => {
    const art = await buyableArtwork(db);
    const link = await linkOrder(art);
    await completeDetails(link.orderId, { method: "LOCAL_PICKUP" });
    const { result } = await startPaymentForOrder(
      { orderId: link.orderId, providerId: "mock", locale: "en", ipHash: null },
      { env: closed },
    );
    expect(result).toEqual({ kind: "refused", code: "SALES_CLOSED" });
  });
});

describe("emails only to the painter (EMAIL_TO_VISITORS=false)", () => {
  it("skips the visitor's acknowledgement and sends the painter the visitor's phone", async () => {
    const a = await insertArtwork(db, { titleEn: "Blue Hour" });
    const buyer = uniqueBuyer("showcase");
    await svc.submitRequest(
      {
        kind: "QUESTION",
        artworkSlug: a.slug,
        name: buyer.name,
        email: buyer.email,
        phone: "+972501234567",
        message: "Can I see it in the studio?",
        locale: "en",
      },
      { ipHash: null },
    );
    await drain();

    expect(await mailbox.list({ template: "request-ack" })).toEqual([]);
    const painter = await getSetting("business_profile");
    const note = await mailbox.latest({
      template: "painter-new-request",
      to: painter.notificationEmail,
    });
    expect(note?.html).toContain("050-123-4567");
    expect(note?.html).toContain("https://wa.me/972501234567");
    // Both jobs finished: nothing retries, fails or alerts.
    const jobs = await db.select().from(outboxJobs);
    expect(jobs.map((j) => j.status)).toEqual(["DONE", "DONE"]);
  });
});

describe("markAnsweredOffline", () => {
  const ctx = testAdminContext();

  async function question() {
    const buyer = uniqueBuyer("offline");
    const [row] = await db
      .insert(buyerRequests)
      .values({
        kind: "QUESTION",
        name: buyer.name,
        email: buyer.email,
        locale: "en",
        message: "Is it still available?",
      })
      .returning();
    if (!row) throw new Error("no request");
    return row;
  }
  async function requestOf(id: string) {
    const [row] = await db
      .select()
      .from(buyerRequests)
      .where(eq(buyerRequests.id, id));
    return row;
  }

  it("moves a new question to REPLIED with the note, emails nothing and records it", async () => {
    const q = await question();
    const { result, effects } = await svc.markAnsweredOffline(
      ctx,
      q.id,
      "  Called back; visiting on Sunday.  ",
    );
    expect(result.status).toBe("REPLIED");
    expect(effects.outbox ?? false).toBe(false);
    expect(await requestOf(q.id)).toMatchObject({
      status: "REPLIED",
      adminReply: "Called back; visiting on Sunday.",
    });
    expect((await requestOf(q.id))?.repliedAt).toBeInstanceOf(Date);
    expect(await db.select().from(outboxJobs)).toEqual([]);
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, q.id),
          eq(auditLog.action, "request.answered_offline"),
        ),
      );
    expect(audit).toHaveLength(1);
    // Only once: an answered question is closed, not answered again.
    expect(await code(svc.markAnsweredOffline(ctx, q.id, null))).toBe(
      "NOT_NEW",
    );
  });

  it("without a note keeps no reply text; a quote request keeps its status", async () => {
    const q = await question();
    await svc.markAnsweredOffline(ctx, q.id, "   ");
    expect(await requestOf(q.id)).toMatchObject({
      status: "REPLIED",
      adminReply: null,
    });

    const art = await buyableArtwork(db);
    const buyer = uniqueBuyer("offline-quote");
    const [quote] = await db
      .insert(buyerRequests)
      .values({
        kind: "QUOTE",
        artworkId: art.id,
        name: buyer.name,
        email: buyer.email,
        locale: "he",
        message: "Delivery to Haifa?",
      })
      .returning();
    const { result } = await svc.markAnsweredOffline(
      ctx,
      quote?.id ?? "",
      null,
    );
    expect(result.status).toBe("NEW");
    expect((await requestOf(quote?.id ?? ""))?.repliedAt).toBeInstanceOf(Date);
  });
});
