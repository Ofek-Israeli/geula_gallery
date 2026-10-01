import "server-only";
import { asc, eq } from "drizzle-orm";
import type { DisclosureDoc } from "@/content/disclosure";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  orderItems,
  orders,
  paymentAttempts,
  refunds,
  taxDocuments,
} from "@/server/db/schema";
import { verifyOrderAccessToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import { loadDisclosure } from "./data";

/**
 * Buyer printables behind the order's `?k=` token (spec §5.4 "Printables"): the disclosure document
 * and the mock receipt / credit note. Both return null for an unknown number or a bad token (the
 * page then rate-limits and 404s, like the order page).
 */
export async function getBuyerDisclosure(
  number: string,
  token: string | null,
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<DisclosureDoc | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.number, number));
  if (!order || !verifyOrderAccessToken(order.id, order.accessVersion, token)) {
    return null;
  }
  // The document exists once the order is paid (the s.14C(b) document follows the contract).
  if (!order.paidAttemptId) return null;
  return loadDisclosure(order, locale, { db });
}

export interface BuyerTaxDocumentView {
  docNumber: string;
  kind: "RECEIPT" | "INVOICE_RECEIPT" | "CREDIT_NOTE";
  isDemo: boolean;
  /** Provider-hosted document (Morning); the page links to it instead of rendering. */
  providerUrl: string | null;
  issuedAt: string;
  orderNumber: string;
  currency: Currency;
  seller: {
    legalName: string;
    idNumber: string;
    vatMode: "OSEK_PATUR" | "OSEK_MURSHE";
    vatNumber?: string;
    address: string;
  };
  buyerName: string;
  /** `title` is the work title for items; other kinds are labelled by the page. */
  lines: {
    kind: "item" | "shipping" | "insurance" | "order" | "refund";
    title: string;
    amountMinor: number;
  }[];
  totalMinor: number;
  payment: {
    method: string | null;
    last4: string | null;
    reference: string | null;
  } | null;
  /** Credit note: the receipt it credits. */
  creditsDocNumber: string | null;
}

export async function getBuyerTaxDocument(
  docNumber: string,
  token: string | null,
  locale: Locale,
  db: DbOrTx = defaultDb,
): Promise<BuyerTaxDocumentView | null> {
  const [doc] = await db
    .select()
    .from(taxDocuments)
    .where(eq(taxDocuments.docNumber, docNumber));
  if (doc?.status !== "ISSUED" || !doc.issuedAt) return null;
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, doc.orderId));
  if (!order || !verifyOrderAccessToken(order.id, order.accessVersion, token)) {
    return null;
  }
  const profile = await getSetting("business_profile", db);
  const [attempt] = doc.attemptId
    ? await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, doc.attemptId))
    : [];
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.createdAt));

  let lines: BuyerTaxDocumentView["lines"];
  let totalMinor: number;
  let creditsDocNumber: string | null = null;
  const currency = attempt?.currency ?? order.currency;
  if (doc.kind === "CREDIT_NOTE" && doc.refundId) {
    const [refund] = await db
      .select()
      .from(refunds)
      .where(eq(refunds.id, doc.refundId));
    totalMinor = refund?.amountMinor ?? 0;
    lines = [
      { kind: "refund", title: refund?.reason ?? "", amountMinor: totalMinor },
    ];
    const [receipt] = await db
      .select({ docNumber: taxDocuments.docNumber })
      .from(taxDocuments)
      .where(eq(taxDocuments.attemptId, doc.attemptId ?? ""))
      .orderBy(asc(taxDocuments.createdAt));
    creditsDocNumber = receipt?.docNumber ?? null;
  } else if (attempt && attempt.amountMinor === order.totalMinor) {
    lines = [
      ...items.map((i) => ({
        kind: "item" as const,
        title: locale === "he" ? i.titleHe : i.titleEn,
        amountMinor: i.priceMinor,
      })),
      ...(order.shippingMinor > 0
        ? [
            {
              kind: "shipping" as const,
              title: "",
              amountMinor: order.shippingMinor,
            },
          ]
        : []),
      ...(order.insuranceMinor > 0
        ? [
            {
              kind: "insurance" as const,
              title: "",
              amountMinor: order.insuranceMinor,
            },
          ]
        : []),
    ];
    totalMinor = attempt.amountMinor;
  } else {
    totalMinor = attempt?.amountMinor ?? order.totalMinor;
    lines = [{ kind: "order", title: order.number, amountMinor: totalMinor }];
  }

  return {
    docNumber,
    kind: doc.kind,
    isDemo: doc.provider === "MOCK",
    providerUrl: doc.docUrl,
    issuedAt: doc.issuedAt.toISOString(),
    orderNumber: order.number,
    currency,
    seller: {
      legalName: profile.legalName,
      idNumber: profile.idNumber,
      vatMode: profile.vatMode,
      ...(profile.vatNumber ? { vatNumber: profile.vatNumber } : {}),
      address: profile.address[locale],
    },
    buyerName: order.buyerName ?? "",
    lines,
    totalMinor,
    payment: attempt
      ? {
          method: attempt.provider === "PAYPAL" ? "paypal" : attempt.method,
          last4: attempt.cardLast4,
          reference: attempt.transactionId ?? attempt.providerRef,
        }
      : null,
    creditsDocNumber,
  };
}
