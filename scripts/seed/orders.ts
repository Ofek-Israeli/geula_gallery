import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  artworks,
  buyerRequests,
  cancellations,
  mockPayments,
  orderItems,
  orders,
  paymentAttempts,
  sales,
  shipmentEvents,
  shipments,
  taxDocuments,
} from "@/server/db/schema";
import { readDemoManifest } from "../lib/demo-manifest";
import type { SeedDb, SeedModule } from "./types";

/**
 * Sample orders (spec §8.4; owner WS6). Three demo orders for the three sold demo works
 * (manifest `sampleOrder` 1–3), each consistent with the invariants (spec §3.4): a SUCCEEDED MOCK
 * attempt bound to the order's quote version and exact total, a matching `mock_payments` row (so a
 * refund through the mock provider works), an ONLINE `is_mock` sale for the order item, the work
 * SOLD, an ISSUED mock receipt, and a shipment. **No outbox jobs** are created.
 *
 * 1. 94241 (the-red-room-etretat): Israeli buyer, ILS, courier via the manual carrier "Israel
 *    Post", DELIVERED 7 days ago — plus a RECEIVED cancellation notice (received 5 days ago, so the
 *    refund is due in 9 days), matched to the order, which blocks fulfillment.
 * 2. 64754 (moonrise): US buyer, a QUOTE link order (from a converted quote request), USD, locked
 *    shipping, a mock waybill, IN_TRANSIT, export declaration recorded.
 * 3. 30928 (terrace-bridge-central-park): Israeli buyer, studio pickup, PAID and awaiting
 *    fulfillment.
 *
 * Idempotent: an order number that already exists is skipped; a work that already has an active
 * sale or is not AVAILABLE is skipped. Placeholder buyers only (`@example.com`, `+972-3-000-0000`).
 * Every transaction locks the artwork first (global lock order).
 */
const DAY = 86_400_000;
const FX_ILS_PER_USD = 3.7;
const DRAFT = "2026-10-01-draft";

interface SampleSpec {
  n: 1 | 2 | 3;
  number: string;
  daysAgo: number;
  buyer: { name: string; email: string };
  country: string;
  currency: "ILS" | "USD";
  method: "CARRIER_TABLE" | "LOCAL_PICKUP";
  source: "WEB" | "QUOTE";
  locale: "he" | "en";
  shippingMinor: number;
}

export const SAMPLE_ORDERS: readonly SampleSpec[] = [
  {
    n: 1,
    number: "GG-SAMP01",
    daysAgo: 12,
    buyer: { name: "דנה כהן", email: "dana.sample@example.com" },
    country: "IL",
    currency: "ILS",
    method: "CARRIER_TABLE",
    source: "WEB",
    locale: "he",
    shippingMinor: 12_000,
  },
  {
    n: 2,
    number: "GG-SAMP02",
    daysAgo: 8,
    buyer: { name: "Alex Morgan", email: "alex.sample@example.com" },
    country: "US",
    currency: "USD",
    method: "CARRIER_TABLE",
    source: "QUOTE",
    locale: "en",
    shippingMinor: 38_000,
  },
  {
    n: 3,
    number: "GG-SAMP03",
    daysAgo: 3,
    buyer: { name: "נועם לוי", email: "noam.sample@example.com" },
    country: "IL",
    currency: "ILS",
    method: "LOCAL_PICKUP",
    source: "WEB",
    locale: "he",
    shippingMinor: 0,
  },
];

const PHONE = "+972-3-000-0000";
const at = (daysAgo: number, hours = 0) =>
  new Date(Date.now() - daysAgo * DAY + hours * 3_600_000);
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export const ordersSeed: SeedModule = {
  name: "orders",
  modes: ["demo"],
  async run({ db, log, env }) {
    const manifest = await readDemoManifest();
    const appUrl = env.authBaseUrl.replace(/\/$/, "");
    let created = 0;
    for (const spec of SAMPLE_ORDERS) {
      const work = manifest.works.find((w) => w.sampleOrder === spec.n);
      if (!work) throw new Error(`orders seed: no sample work ${spec.n}`);
      const done = await db.transaction((tx) =>
        seedOrder(tx as unknown as SeedDb, spec, work.slug, appUrl),
      );
      if (done) created++;
    }
    log(`orders: ${created} sample orders created (3 on a fresh database)`);
  },
};

async function seedOrder(
  tx: SeedDb,
  spec: SampleSpec,
  slug: string,
  appUrl: string,
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.number, spec.number));
  if (existing) return false;

  // Artworks first (global lock order), then every row that references it.
  const [art] = await tx
    .select()
    .from(artworks)
    .where(eq(artworks.slug, slug))
    .for("update");
  if (!art) throw new Error(`orders seed: artwork ${slug} not found`);
  const [active] = await tx
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.artworkId, art.id), isNull(sales.voidedAt)))
    .limit(1);
  if (active || art.saleStatus !== "AVAILABLE" || art.reservedByOrderId) {
    return false;
  }

  const price =
    spec.currency === "USD"
      ? (art.priceUsdMinor ?? 0)
      : (art.priceIlsMinor ?? 0);
  if (price <= 0) {
    throw new Error(`orders seed: ${slug} has no ${spec.currency} price`);
  }
  const total = price + spec.shippingMinor;
  const created = at(spec.daysAgo, -1);
  const paidAt = at(spec.daysAgo);
  const international = spec.country !== "IL";

  const [order] = await tx
    .insert(orders)
    .values({
      number: spec.number,
      source: spec.source,
      status: "AWAITING_PAYMENT",
      locale: spec.locale,
      currency: spec.currency,
      isDemo: true,
      itemsTotalMinor: price,
      shippingMinor: spec.shippingMinor,
      insuranceMinor: 0,
      totalMinor: total,
      vatMode: "OSEK_PATUR",
      vatRateBp: 0,
      vatMinor: 0,
      ...(spec.currency === "USD"
        ? { fxIlsPerUnit: String(FX_ILS_PER_USD) }
        : {}),
      quoteVersion: 1,
      buyerName: spec.buyer.name,
      buyerEmail: spec.buyer.email,
      buyerPhone: PHONE,
      shipCountry: spec.country,
      ...(spec.method === "CARRIER_TABLE"
        ? {
            shipName: spec.buyer.name,
            shipLine1: international ? "1 Sample Street" : "רחוב הדוגמה 1",
            shipCity: international ? "Springfield" : "תל אביב",
            shipPostalCode: international ? "00000" : "6100000",
            ...(international ? { shipRegion: "IL" } : {}),
            shipPhone: PHONE,
          }
        : {}),
      shippingMethod: spec.method,
      shippingLocked: spec.source === "QUOTE",
      shippingQuote: {
        method: spec.method,
        carrier:
          spec.method === "LOCAL_PICKUP"
            ? null
            : international
              ? "MOCK"
              : "MANUAL",
        currency: spec.currency,
        shippingMinor: spec.shippingMinor,
        insuranceMinor: 0,
        insured: false,
        insuredValueMinor: 0,
        estimate: international
          ? { he: "5–8 ימי עסקים", en: "5–8 business days" }
          : spec.method === "LOCAL_PICKUP"
            ? { he: "בתיאום", en: "By arrangement" }
            : { he: "3–5 ימי עסקים", en: "3–5 business days" },
      },
      termsVersion: DRAFT,
      returnsVersion: DRAFT,
      privacyVersion: DRAFT,
      termsAcceptedAt: created,
      ageConfirmedAt: created,
      ...(international
        ? { dutiesNoticeVersion: DRAFT, dutiesAckAt: created }
        : {}),
      receiptEmailConsent: true,
      conversationTookPlace: spec.source === "QUOTE",
      conversationSource: spec.source === "QUOTE" ? "LINK" : null,
      disclosureVersion: DRAFT,
      disclosureSentAt: paidAt,
      firstHeldAt: created,
      holdCount: 1,
      createdAt: created,
      updatedAt: paidAt,
    })
    .returning();
  if (!order) throw new Error("orders seed: order insert");

  const [item] = await tx
    .insert(orderItems)
    .values({
      orderId: order.id,
      artworkId: art.id,
      titleHe: art.titleHe,
      titleEn: art.titleEn,
      priceMinor: price,
      currency: spec.currency,
      declaredValueMinor: art.declaredValueOverrideMinor ?? art.priceIlsMinor,
      snapshot: {
        slug: art.slug,
        inventoryNumber: art.inventoryNumber,
        heightMm: art.heightMm,
        widthMm: art.widthMm,
        depthMm: art.depthMm,
        medium: art.medium,
        surface: art.surface,
        yearCreated: art.yearCreated,
        mediumDetailHe: art.mediumDetailHe,
        mediumDetailEn: art.mediumDetailEn,
        framed: art.framed,
        signed: art.signed,
        coaIncluded: art.coaIncluded,
        isDemo: art.isDemo,
      },
      createdAt: created,
    })
    .returning();
  if (!item) throw new Error("orders seed: item insert");

  const ref = `mock_${hex(16)}`;
  const transactionId = `mocktx_${hex(8)}`;
  const [attempt] = await tx
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      seq: 1,
      provider: "MOCK",
      providerMode: "MOCK",
      merchantRef: "mock-merchant",
      isDemo: true,
      status: "SUCCEEDED",
      quoteVersion: 1,
      amountMinor: total,
      currency: spec.currency,
      providerRef: ref,
      transactionId,
      method: "card",
      cardLast4: "4242",
      cardBrand: "mock",
      finalizedAt: paidAt,
      lastCheckedAt: paidAt,
      createdAt: created,
      updatedAt: paidAt,
    })
    .returning();
  if (!attempt) throw new Error("orders seed: attempt insert");

  const back = `${appUrl}/${spec.locale}/orders/${spec.number}`;
  await tx.insert(mockPayments).values({
    ref,
    attemptId: attempt.id,
    amountMinor: total,
    currency: spec.currency,
    flow: "DIRECT",
    state: "PAID",
    transactionId,
    returnUrl: back,
    cancelUrl: back,
    notifyUrl: `${appUrl}/api/payments/mock/webhook`,
    createdAt: created,
  });

  await tx
    .update(orders)
    .set({ status: "PAID", paidAttemptId: attempt.id, paidAt })
    .where(eq(orders.id, order.id));

  await tx.insert(sales).values({
    artworkId: art.id,
    orderId: order.id,
    orderItemId: item.id,
    channel: "ONLINE",
    priceMinor: price,
    currency: spec.currency,
    isMock: true,
    soldAt: paidAt,
    createdBy: "seed",
  });
  const marked = await tx
    .update(artworks)
    .set({ saleStatus: "SOLD", soldAt: paidAt, updatedAt: sql`now()` })
    .where(
      and(
        eq(artworks.id, art.id),
        eq(artworks.saleStatus, "AVAILABLE"),
        isNull(artworks.reservedByOrderId),
      ),
    )
    .returning({ id: artworks.id });
  if (marked.length !== 1) {
    throw new Error(`orders seed: could not sell ${slug}`);
  }

  const suffix = spec.number.slice(3);
  await tx.insert(taxDocuments).values({
    orderId: order.id,
    attemptId: attempt.id,
    kind: "RECEIPT",
    provider: "MOCK",
    status: "ISSUED",
    marker: `${spec.number}/RECEIPT/1`,
    providerDocId: `mock-doc-${suffix}-R1`,
    docNumber: `DEMO-${suffix}-R1`,
    docTypeCode: 400,
    attempts: 1,
    lastAttemptAt: paidAt,
    issuedAt: paidAt,
  });

  await seedShipment(tx, spec, order.id, art, paidAt);

  if (spec.source === "QUOTE") {
    await tx.insert(buyerRequests).values({
      kind: "QUOTE",
      artworkId: art.id,
      name: spec.buyer.name,
      email: spec.buyer.email,
      country: spec.country,
      locale: spec.locale,
      message: "Could you quote shipping to the US?",
      status: "CONVERTED",
      orderId: order.id,
      adminReply: "Quote sent with a payment link.",
      repliedAt: created,
      createdAt: at(spec.daysAgo + 2),
    });
  }

  if (spec.n === 1) await seedCancellation(tx, spec, order.id, total);
  return true;
}

/** Order 1: delivered 7 days ago, a RECEIVED cancellation 5 days ago (refund due in 9 days). */
async function seedCancellation(
  tx: SeedDb,
  spec: SampleSpec,
  orderId: string,
  total: number,
) {
  const deliveredAt = at(7);
  const receivedAt = at(5);
  const windowEnds = new Date(deliveredAt.getTime() + 14 * DAY);
  const refundDue = new Date(receivedAt.getTime() + 14 * DAY);
  const fee = Math.min(Math.round(total * 0.05), 10_000);
  await tx
    .update(orders)
    .set({
      deliveredAt,
      cancellationWindowEndsAt: windowEnds,
      fulfillmentBlockedReason: "PENDING_CANCELLATION",
    })
    .where(eq(orders.id, orderId));
  await tx.insert(cancellations).values({
    number: "C-SAMP01",
    orderId,
    regime: "IL",
    status: "RECEIVED",
    returnStatus: "NOT_APPLICABLE",
    channel: "WEB",
    reason: "CHANGE_OF_MIND",
    fullName: spec.buyer.name,
    orderNumberInput: spec.number,
    email: spec.buyer.email,
    eligibleGroup: "NONE",
    receivedAt,
    ackSentAt: receivedAt,
    ackSnapshot: {
      number: "C-SAMP01",
      fullName: spec.buyer.name,
      idNumberMasked: null,
      idKind: null,
      orderNumber: spec.number,
      email: spec.buyer.email,
      phone: null,
      reason: "CHANGE_OF_MIND",
      message: null,
      shippedTo: "IL",
      eligibleGroup: "NONE",
      channel: "WEB",
      receivedAt: receivedAt.toISOString(),
      refundDueAt: refundDue.toISOString(),
      locale: "he",
      receivedAtText: receivedAt.toISOString(),
    },
    windowEndsAt: windowEnds,
    withinWindow: true,
    feeMinor: fee,
    refundAmountMinor: total - fee,
    refundDueAt: refundDue,
  });
}

async function seedShipment(
  tx: SeedDb,
  spec: SampleSpec,
  orderId: string,
  art: typeof artworks.$inferSelect,
  paidAt: Date,
) {
  if (spec.method === "LOCAL_PICKUP") {
    await tx.insert(shipments).values({
      orderId,
      status: "AWAITING_FULFILLMENT",
      method: "LOCAL_PICKUP",
      exportDeclStatus: "NOT_REQUIRED",
    });
    return;
  }
  const international = spec.country !== "IL";
  const shippedAt = new Date(paidAt.getTime() + 2 * DAY);
  const packages = [
    {
      lengthMm: art.packedLengthMm,
      widthMm: art.packedWidthMm,
      heightMm: art.packedHeightMm,
      weightG: art.packedWeightG,
    },
  ];
  if (!international) {
    const deliveredAt = at(7);
    const [s] = await tx
      .insert(shipments)
      .values({
        orderId,
        status: "DELIVERED",
        method: "CARRIER_TABLE",
        carrier: "MANUAL",
        carrierName: "Israel Post",
        trackingNumber: "RR000000001IL",
        packages,
        declaredValueMinor: art.priceIlsMinor,
        declaredCurrency: "ILS",
        exportDeclStatus: "NOT_REQUIRED",
        shippedAt,
        deliveredAt,
        insuranceClaimDeadlineAt: new Date(deliveredAt.getTime() + 30 * DAY),
      })
      .returning({ id: shipments.id });
    if (!s) throw new Error("orders seed: shipment");
    await tx.insert(shipmentEvents).values([
      {
        shipmentId: s.id,
        occurredAt: shippedAt,
        status: "LABEL_CREATED",
        code: "MANUAL-1",
        source: "MANUAL",
        description: "Handed to Israel Post",
      },
      {
        shipmentId: s.id,
        occurredAt: new Date(shippedAt.getTime() + 3_600_000),
        status: "IN_TRANSIT",
        code: "MANUAL-2",
        source: "MANUAL",
        description: "In transit",
      },
      {
        shipmentId: s.id,
        occurredAt: deliveredAt,
        status: "DELIVERED",
        code: "MANUAL-3",
        source: "MANUAL",
        description: "Delivered",
      },
    ]);
    return;
  }
  const [s] = await tx
    .insert(shipments)
    .values({
      orderId,
      status: "IN_TRANSIT",
      method: "CARRIER_TABLE",
      carrier: "MOCK",
      carrierName: "Mock Express",
      adapterMode: "mock",
      trackingNumber: "MOCK0000000002",
      packages,
      declaredValueMinor: art.priceUsdMinor,
      declaredCurrency: "USD",
      hsCode: art.hsCode,
      originCountry: "IL",
      contentsDescriptionEn:
        art.customsDescriptionEn ?? "Original oil painting on canvas",
      reasonForExport: "SALE",
      incoterm: "DAP",
      commercialInvoiceNumber: `CI-${spec.number}`,
      exportDeclarationNumber: "SAMPLE-EXPORT-0002",
      exportDeclStatus: "RECORDED",
      shippedAt,
      estimatedDeliveryAt: new Date(shippedAt.getTime() + 6 * DAY),
      lastTrackedAt: new Date(),
    })
    .returning({ id: shipments.id });
  if (!s) throw new Error("orders seed: shipment");
  await tx.insert(shipmentEvents).values([
    {
      shipmentId: s.id,
      occurredAt: shippedAt,
      status: "LABEL_CREATED",
      code: "PU",
      source: "SYSTEM",
      description: "Shipment picked up",
    },
    {
      shipmentId: s.id,
      occurredAt: new Date(shippedAt.getTime() + DAY),
      status: "IN_TRANSIT",
      code: "PL",
      source: "SYSTEM",
      description: "Departed facility, Tel Aviv",
    },
  ]);
}
