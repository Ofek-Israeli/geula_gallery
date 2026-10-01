import "server-only";
import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { audit, auditBy } from "@/server/audit";
import {
  type CreateLinkOrderInput,
  createLinkOrder,
} from "@/server/checkout/links";
import { type Db, type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  type BuyerRequest,
  buyerRequests,
  orders,
} from "@/server/db/schema";
import type { RequestTopic } from "@/server/db/schema/enums";
import { withTx } from "@/server/db/tx";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
} from "@/server/domain/errors";
import type { RequestStatus } from "@/server/domain/state-machines";
import { transition } from "@/server/domain/transition";
import type { Env } from "@/server/env";
import { getUntypedTranslator } from "@/server/i18n";
import { enqueueEmail } from "@/server/outbox/enqueue";
import { getSetting } from "@/server/settings";

/**
 * Buyer requests (spec §5.8, §3.6 "Buyer request"): questions, quote requests and (Tier B) offers
 * from the public forms; the admin inbox (reply, decline, close, send quote → link order).
 *
 * - Submitting stores the row and enqueues `request-ack` (buyer, their locale) and
 *   `painter-new-request` (the painter's notification address, Hebrew) in one transaction.
 * - Replies are emailed with `request-reply`; the refId is `<requestId>:<n>` (n = 1, 2, …) so every
 *   reply is its own idempotent email. The builder reads the stored `admin_reply`.
 * - "Send quote" calls `createLinkOrder({ kind: 'QUOTE', requestId })` (WS2), which moves the
 *   request to QUOTED with its `order_id` and emails the payment link (`checkout-link`).
 */
export type RequestKind = "QUESTION" | "QUOTE" | "OFFER";

export interface SubmitRequestInput {
  kind: RequestKind;
  /** The artwork the request is about (required for QUOTE and OFFER). */
  artworkSlug?: string | null;
  topic?: RequestTopic | null;
  name: string;
  email: string;
  phone?: string | null;
  country?: string | null;
  message: string;
  offerAmountMinor?: number | null;
  offerCurrency?: Currency | null;
  locale: Locale;
}

export interface RequestDeps {
  db?: Db;
}

async function painterAddress(db: DbOrTx): Promise<string> {
  const profile = await getSetting("business_profile", db);
  return profile.notificationEmail;
}

export async function submitRequest(
  input: SubmitRequestInput,
  meta: { ipHash: string | null },
  deps: RequestDeps = {},
): Promise<ServiceResult<{ requestId: string }>> {
  const db = deps.db ?? defaultDb;
  if (input.kind === "OFFER") {
    if (
      !input.offerAmountMinor ||
      input.offerAmountMinor <= 0 ||
      !input.offerCurrency
    ) {
      throw new ConflictError("OFFER_AMOUNT", "an offer amount is required");
    }
    if (input.country === "IL" && input.offerCurrency !== "ILS") {
      throw new ConflictError(
        "IL_REQUIRES_ILS",
        "offers for Israel are in ILS",
      );
    }
  }
  try {
    const requestId = await withTx(
      async (tx) => {
        let artworkId: string | null = null;
        let autoDecline = false;
        let title = "";
        if (input.artworkSlug) {
          const [a] = await tx
            .select({
              id: artworks.id,
              isPublished: artworks.isPublished,
              saleStatus: artworks.saleStatus,
              offersEnabled: artworks.offersEnabled,
              autoDeclineBelow: artworks.offerAutoDeclineBelowIlsMinor,
              titleHe: artworks.titleHe,
              titleEn: artworks.titleEn,
            })
            .from(artworks)
            .where(eq(artworks.slug, input.artworkSlug));
          if (!a?.isPublished) throw new NotFoundError("artwork");
          if (input.kind === "QUOTE" && a.saleStatus !== "AVAILABLE") {
            throw new ConflictError(
              "NOT_REQUESTABLE",
              "quotes are only for available works",
            );
          }
          if (
            input.kind === "OFFER" &&
            (!a.offersEnabled || a.saleStatus !== "AVAILABLE")
          ) {
            throw new ConflictError(
              "NOT_REQUESTABLE",
              "offers are not enabled",
            );
          }
          artworkId = a.id;
          autoDecline =
            input.kind === "OFFER" &&
            a.autoDeclineBelow !== null &&
            (await offerInIlsMinor(tx, input)) < a.autoDeclineBelow;
          title = input.locale === "he" ? a.titleHe : a.titleEn;
        } else if (input.kind !== "QUESTION") {
          throw new ConflictError("NOT_REQUESTABLE", "an artwork is required");
        }
        const [row] = await tx
          .insert(buyerRequests)
          .values({
            kind: input.kind,
            topic: input.topic ?? null,
            artworkId,
            name: input.name,
            email: input.email,
            phone: input.phone ?? null,
            country: input.country ?? null,
            locale: input.locale,
            message: input.message,
            offerAmountMinor: input.offerAmountMinor ?? null,
            offerCurrency: input.offerCurrency ?? null,
            ipHash: meta.ipHash,
          })
          .returning({ id: buyerRequests.id });
        if (!row) throw new Error("buyer_requests insert returned no row");
        if (autoDecline) {
          // Below the painter's threshold (spec §5.8): declined at once with a polite reply in
          // the buyer's language; the painter is not notified.
          const reply = getUntypedTranslator(input.locale)(
            "requests.autoDecline",
            { name: input.name, title },
          );
          await transition(
            tx,
            "buyerRequest",
            row.id,
            ["NEW"],
            "AUTO_DECLINED",
            { adminReply: reply, repliedAt: new Date() },
            "system",
            { action: "request.auto_declined" },
          );
          await enqueueEmail(tx, {
            template: "request-reply",
            to: input.email,
            locale: input.locale,
            refId: `${row.id}:1`,
          });
          return row.id;
        }
        await enqueueEmail(tx, {
          template: "request-ack",
          to: input.email,
          locale: input.locale,
          refId: row.id,
        });
        await enqueueEmail(tx, {
          template: "painter-new-request",
          to: await painterAddress(tx),
          locale: "he",
          refId: row.id,
        });
        await audit(
          {
            actor: "anonymous",
            action: "request.received",
            entity: "buyer_request",
            entityId: row.id,
            after: { kind: input.kind, artworkId, topic: input.topic ?? null },
            ipHash: meta.ipHash,
          },
          tx,
        );
        return row.id;
      },
      { db, name: "requests.submit" },
    );
    return withEffects({ requestId }, { outbox: true });
  } catch (error) {
    if (isUniqueViolation(error, "buyer_requests_one_new_offer_idx")) {
      throw new ConflictError("OFFER_PENDING", "an offer is already pending");
    }
    throw error;
  }
}

/** The offer in ILS minor units (USD converted with the settings FX), for the threshold. */
async function offerInIlsMinor(
  db: DbOrTx,
  input: Pick<SubmitRequestInput, "offerAmountMinor" | "offerCurrency">,
): Promise<number> {
  const amount = input.offerAmountMinor ?? 0;
  if (input.offerCurrency !== "USD") return amount;
  const checkout = await getSetting("checkout", db);
  return Math.round(amount * checkout.fx.ilsPerUsd);
}

// ---------------------------------------------------------------- admin inbox

/** Statuses that need the painter's attention. */
export const OPEN_REQUEST_STATUSES = [
  "NEW",
] as const satisfies readonly RequestStatus[];

export type InboxFilter = "open" | "quotes" | "offers" | "questions" | "all";

export interface InboxRow {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  name: string;
  email: string;
  country: string | null;
  createdAt: Date;
  message: string;
  artworkTitleHe: string | null;
  artworkTitleEn: string | null;
}

export async function listRequests(
  _ctx: AdminContext,
  opts: { filter?: InboxFilter; page?: number } = {},
  db: DbOrTx = defaultDb,
): Promise<{ rows: InboxRow[]; total: number; page: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const f = opts.filter ?? "open";
  const where = and(
    f === "open"
      ? inArray(buyerRequests.status, [...OPEN_REQUEST_STATUSES])
      : undefined,
    f === "quotes" ? eq(buyerRequests.kind, "QUOTE") : undefined,
    f === "offers" ? eq(buyerRequests.kind, "OFFER") : undefined,
    f === "questions" ? eq(buyerRequests.kind, "QUESTION") : undefined,
  );
  const rows = await db
    .select({
      id: buyerRequests.id,
      kind: buyerRequests.kind,
      status: buyerRequests.status,
      name: buyerRequests.name,
      email: buyerRequests.email,
      country: buyerRequests.country,
      createdAt: buyerRequests.createdAt,
      message: buyerRequests.message,
      artworkTitleHe: artworks.titleHe,
      artworkTitleEn: artworks.titleEn,
    })
    .from(buyerRequests)
    .leftJoin(artworks, eq(artworks.id, buyerRequests.artworkId))
    .where(where)
    .orderBy(desc(buyerRequests.createdAt), desc(buyerRequests.id))
    .limit(50)
    .offset((page - 1) * 50);
  const [total] = await db
    .select({ n: count() })
    .from(buyerRequests)
    .where(where);
  return { rows, total: total?.n ?? 0, page };
}

export async function countOpenRequests(
  db: DbOrTx = defaultDb,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(buyerRequests)
    .where(inArray(buyerRequests.status, [...OPEN_REQUEST_STATUSES]));
  return row?.n ?? 0;
}

export interface RequestDetail {
  request: BuyerRequest;
  artwork: {
    id: string;
    slug: string;
    titleHe: string;
    titleEn: string;
    saleStatus: string;
    priceIlsMinor: number | null;
    priceUsdMinor: number | null;
    quoteOnly: boolean;
  } | null;
  order: { id: string; number: string; status: string } | null;
  /** Other requests from the same email (conversation history). */
  history: {
    id: string;
    kind: RequestKind;
    status: RequestStatus;
    createdAt: Date;
  }[];
}

export async function getRequest(
  _ctx: AdminContext,
  id: string,
  db: DbOrTx = defaultDb,
): Promise<RequestDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [request] = await db
    .select()
    .from(buyerRequests)
    .where(eq(buyerRequests.id, id));
  if (!request) return null;
  const [artwork] = request.artworkId
    ? await db
        .select({
          id: artworks.id,
          slug: artworks.slug,
          titleHe: artworks.titleHe,
          titleEn: artworks.titleEn,
          saleStatus: artworks.saleStatus,
          priceIlsMinor: artworks.priceIlsMinor,
          priceUsdMinor: artworks.priceUsdMinor,
          quoteOnly: artworks.quoteOnly,
        })
        .from(artworks)
        .where(eq(artworks.id, request.artworkId))
    : [];
  const [order] = request.orderId
    ? await db
        .select({ id: orders.id, number: orders.number, status: orders.status })
        .from(orders)
        .where(eq(orders.id, request.orderId))
    : [];
  const history = await db
    .select({
      id: buyerRequests.id,
      kind: buyerRequests.kind,
      status: buyerRequests.status,
      createdAt: buyerRequests.createdAt,
    })
    .from(buyerRequests)
    .where(
      and(
        sql`lower(${buyerRequests.email}) = ${request.email.toLowerCase()}`,
        ne(buyerRequests.id, request.id),
      ),
    )
    .orderBy(desc(buyerRequests.createdAt))
    .limit(20);
  return {
    request,
    artwork: artwork ?? null,
    order: order ?? null,
    history,
  };
}

async function lockRequest(tx: DbOrTx, id: string): Promise<BuyerRequest> {
  const [row] = await tx
    .select()
    .from(buyerRequests)
    .where(eq(buyerRequests.id, id))
    .for("update");
  if (!row) throw new NotFoundError("buyer_request", id);
  return row;
}

/** Counts the replies already emailed for a request (refIds `<id>:<n>`). */
async function nextReplyNumber(tx: DbOrTx, id: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM outbox_jobs WHERE dedupe_key LIKE ${`email:request-reply:${id}:%`}`,
  );
  return (rows.rows[0]?.n ?? 0) + 1;
}

async function emailReply(tx: DbOrTx, r: BuyerRequest): Promise<void> {
  const n = await nextReplyNumber(tx, r.id);
  await enqueueEmail(tx, {
    template: "request-reply",
    to: r.email,
    locale: r.locale,
    refId: `${r.id}:${n}`,
  });
}

/**
 * Emails a reply to the buyer. A question moves NEW → REPLIED; quotes and offers keep their status
 * (a reply there is a clarification; the quote itself is "Send quote").
 */
export async function replyToRequest(
  ctx: AdminContext,
  id: string,
  reply: string,
  deps: RequestDeps = {},
): Promise<ServiceResult<{ status: RequestStatus }>> {
  const text = reply.trim();
  if (!text) throw new ConflictError("REPLY_REQUIRED", "the reply is empty");
  const status = await withTx(
    async (tx) => {
      const r = await lockRequest(tx, id);
      const patch = { adminReply: text, repliedAt: new Date() };
      let status: RequestStatus = r.status;
      if (r.kind === "QUESTION" && r.status === "NEW") {
        await transition(
          tx,
          "buyerRequest",
          r.id,
          ["NEW"],
          "REPLIED",
          patch,
          ctx.actor,
          {
            action: "request.replied",
            ipHash: ctx.ipHash,
          },
        );
        status = "REPLIED";
      } else {
        await tx
          .update(buyerRequests)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(buyerRequests.id, r.id));
        await audit(
          {
            ...auditBy(ctx),
            action: "request.replied",
            entity: "buyer_request",
            entityId: r.id,
          },
          tx,
        );
      }
      await emailReply(tx, { ...r, ...patch });
      return status;
    },
    { db: deps.db, name: "requests.reply" },
  );
  return withEffects({ status }, { outbox: true });
}

/** Quote or offer NEW → DECLINED, with an optional emailed reply. */
export async function declineRequest(
  ctx: AdminContext,
  id: string,
  reply: string | null,
  deps: RequestDeps = {},
): Promise<ServiceResult<{ status: RequestStatus }>> {
  const text = reply?.trim() || null;
  await withTx(
    async (tx) => {
      const r = await lockRequest(tx, id);
      if (r.kind === "QUESTION") {
        throw new ConflictError("NOT_DECLINABLE", "questions are replied to");
      }
      const patch = text ? { adminReply: text, repliedAt: new Date() } : {};
      await transition(
        tx,
        "buyerRequest",
        r.id,
        ["NEW"],
        "DECLINED",
        patch,
        ctx.actor,
        {
          action: "request.declined",
          ipHash: ctx.ipHash,
        },
      );
      if (text) await emailReply(tx, { ...r, adminReply: text });
    },
    { db: deps.db, name: "requests.decline" },
  );
  return withEffects(
    { status: "DECLINED" as const },
    text ? { outbox: true } : {},
  );
}

/** Question REPLIED → CLOSED (archive). */
export async function closeRequest(
  ctx: AdminContext,
  id: string,
  deps: RequestDeps = {},
): Promise<ServiceResult<{ status: RequestStatus }>> {
  await withTx(
    async (tx) => {
      const r = await lockRequest(tx, id);
      await transition(
        tx,
        "buyerRequest",
        r.id,
        ["REPLIED"],
        "CLOSED",
        {},
        ctx.actor,
        {
          action: "request.closed",
          ipHash: ctx.ipHash,
        },
      );
    },
    { db: deps.db, name: "requests.close" },
  );
  return withEffects({ status: "CLOSED" as const });
}

export type SendQuoteInput = Pick<
  CreateLinkOrderInput,
  | "country"
  | "currency"
  | "itemPriceMinor"
  | "lockedShippingMinor"
  | "shippingMethod"
  | "expiresInHours"
  | "priceChangeReason"
> & { buyer: { name: string; email: string; phone: string } };

/**
 * "Send quote" (spec §5.8 Tier A): a NEW quote request becomes a link order at a locked price
 * through `createLinkOrder({ kind: 'QUOTE', requestId })`, which also moves the request to QUOTED.
 */
export async function sendQuote(
  ctx: AdminContext,
  id: string,
  input: SendQuoteInput,
  deps: RequestDeps = {},
): Promise<
  ServiceResult<{ orderId: string; orderNumber: string; linkUrl: string }>
> {
  const db = deps.db ?? defaultDb;
  const [r] = await db
    .select()
    .from(buyerRequests)
    .where(eq(buyerRequests.id, id));
  if (!r) throw new NotFoundError("buyer_request", id);
  if (r.kind !== "QUOTE" || r.status !== "NEW") {
    throw new ConflictError(
      "NOT_QUOTABLE",
      "only a new quote request can be quoted",
    );
  }
  if (!r.artworkId) throw new ConflictError("NOT_QUOTABLE", "no artwork");
  if (input.country === "IL" && input.currency !== "ILS") {
    throw new ConflictError("IL_REQUIRES_ILS", "Israeli orders are in ILS");
  }
  return createLinkOrder(
    {
      kind: "QUOTE",
      artworkId: r.artworkId,
      buyer: input.buyer,
      country: input.country,
      currency: input.currency,
      itemPriceMinor: input.itemPriceMinor,
      lockedShippingMinor: input.lockedShippingMinor,
      shippingMethod: input.shippingMethod,
      conversationTookPlace: true,
      expiresInHours: input.expiresInHours,
      locale: r.locale,
      requestId: r.id,
      priceChangeReason: input.priceChangeReason,
    },
    ctx,
  );
}

/**
 * Offers (spec §5.8, Tier B): "accept" sends a link at exactly the offered amount and currency;
 * "counter" sends a link at the admin's price. Both go through `createLinkOrder({ kind: 'OFFER',
 * requestId })`, which moves the request to ACCEPTED or COUNTERED (WS2 contract: the link price
 * equal to the offer ⇒ ACCEPTED, otherwise COUNTERED).
 */
export async function answerOffer(
  ctx: AdminContext,
  id: string,
  mode: "accept" | "counter",
  input: SendQuoteInput,
  deps: RequestDeps = {},
): Promise<
  ServiceResult<{ orderId: string; orderNumber: string; linkUrl: string }>
> {
  const db = deps.db ?? defaultDb;
  const [r] = await db
    .select()
    .from(buyerRequests)
    .where(eq(buyerRequests.id, id));
  if (!r) throw new NotFoundError("buyer_request", id);
  if (r.kind !== "OFFER" || r.status !== "NEW" || !r.artworkId) {
    throw new ConflictError(
      "NOT_ANSWERABLE",
      "only a new offer can be answered",
    );
  }
  if (input.country === "IL" && input.currency !== "ILS") {
    throw new ConflictError("IL_REQUIRES_ILS", "Israeli orders are in ILS");
  }
  const accept = mode === "accept";
  if (
    accept &&
    (input.itemPriceMinor !== r.offerAmountMinor ||
      input.currency !== r.offerCurrency)
  ) {
    throw new ConflictError(
      "ACCEPT_MUST_MATCH",
      "accepting keeps the offered price",
    );
  }
  if (!accept && input.itemPriceMinor === r.offerAmountMinor) {
    throw new ConflictError(
      "COUNTER_SAME_PRICE",
      "a counter-offer needs another price",
    );
  }
  return createLinkOrder(
    {
      kind: "OFFER",
      artworkId: r.artworkId,
      buyer: input.buyer,
      country: input.country,
      currency: input.currency,
      itemPriceMinor: input.itemPriceMinor,
      lockedShippingMinor: input.lockedShippingMinor,
      shippingMethod: input.shippingMethod,
      conversationTookPlace: true,
      expiresInHours: input.expiresInHours,
      locale: r.locale,
      requestId: r.id,
      priceChangeReason:
        input.priceChangeReason ??
        (accept ? "accepted offer" : "counter-offer"),
    },
    ctx,
  );
}

// ---------------------------------------------------------------- email props (SEND_EMAIL)

async function requestWithTitle(db: DbOrTx, id: string) {
  const [row] = await db
    .select({
      request: buyerRequests,
      titleHe: artworks.titleHe,
      titleEn: artworks.titleEn,
    })
    .from(buyerRequests)
    .leftJoin(artworks, eq(artworks.id, buyerRequests.artworkId))
    .where(eq(buyerRequests.id, id));
  if (!row) throw new NotFoundError("buyer_request", id);
  return row;
}

const titleIn = (
  row: { titleHe: string | null; titleEn: string | null },
  locale: Locale,
) => (locale === "he" ? row.titleHe : row.titleEn) ?? undefined;

/** `request-ack` props (refId = request id), in the request's locale. */
export async function requestAckEmail(refId: string, db: DbOrTx) {
  const row = await requestWithTitle(db, refId);
  const r = row.request;
  return {
    locale: r.locale,
    orderId: null,
    props: {
      name: r.name,
      kind: r.kind,
      ...(titleIn(row, r.locale)
        ? { artworkTitle: titleIn(row, r.locale) }
        : {}),
      message: r.message,
    },
  };
}

/** `request-reply` props (refId = `<request id>:<n>`): the stored reply. */
export async function requestReplyEmail(refId: string, db: DbOrTx) {
  const [id = ""] = refId.split(":");
  const row = await requestWithTitle(db, id);
  const r = row.request;
  if (!r.adminReply) throw new NotFoundError("request reply", id);
  return {
    locale: r.locale,
    orderId: r.orderId,
    props: {
      name: r.name,
      ...(titleIn(row, r.locale)
        ? { artworkTitle: titleIn(row, r.locale) }
        : {}),
      reply: r.adminReply,
    },
  };
}

/** `painter-new-request` props (refId = request id); always Hebrew. */
export async function painterNewRequestEmail(
  refId: string,
  db: DbOrTx,
  env: Pick<Env, "APP_URL">,
) {
  const row = await requestWithTitle(db, refId);
  const r = row.request;
  return {
    locale: "he" as const,
    orderId: null,
    props: {
      adminRequestUrl: absoluteUrl(
        env.APP_URL,
        localePath("he", paths.admin.request(r.id)),
      ),
      kind: r.kind,
      name: r.name,
      email: r.email,
      ...(r.country ? { country: r.country } : {}),
      ...(row.titleHe ? { artworkTitle: row.titleHe } : {}),
      message: r.message,
      ...(r.offerAmountMinor && r.offerCurrency
        ? {
            offerAmountMinor: r.offerAmountMinor,
            offerCurrency: r.offerCurrency,
          }
        : {}),
    },
  };
}
