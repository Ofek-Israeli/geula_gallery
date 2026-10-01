import "server-only";
import { asc, eq } from "drizzle-orm";
import {
  buildDisclosure,
  type DisclosureDoc,
  type DisclosureInput,
} from "@/content/disclosure";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import type { Locale } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  type Order,
  orderItems,
  orders,
  paymentAttempts,
} from "@/server/db/schema";
import { NotFoundError } from "@/server/domain/errors";
import { env as defaultEnv, type Env } from "@/server/env";
import { orderAccessToken } from "@/server/security/tokens";
import { getSetting } from "@/server/settings";
import type { ShippingQuoteResult } from "@/server/shipping/types";

/**
 * Data for the buyer documents (spec §5.4): one place that turns an order into the
 * `DisclosureInput` for `content/disclosure.ts#buildDisclosure`, used by the `order-confirmation`
 * email (inline summary), the HTML page `/[locale]/print/disclosure/[number]?k=` and (Tier B) the
 * PDF. Everything comes from the order's own snapshots (items, amounts, shipping quote), never from
 * the live artwork rows, so a later edit cannot change what the buyer was told.
 */
interface ItemSnapshot {
  inventoryNumber?: string;
  heightMm?: number;
  widthMm?: number;
  depthMm?: number | null;
  yearCreated?: number | null;
  mediumDetailHe?: string | null;
  mediumDetailEn?: string | null;
  framed?: boolean;
  signed?: boolean;
  coaIncluded?: boolean;
}

const PAYMENT_METHOD_TEXT = {
  he: {
    card: "כרטיס אשראי",
    paypal: "PayPal",
    bit: "Bit",
    apple_pay: "Apple Pay",
    google_pay: "Google Pay",
    transfer: "העברה בנקאית",
    cash: "מזומן",
    cheque: "המחאה",
    other: "אחר",
  },
  en: {
    card: "Card",
    paypal: "PayPal",
    bit: "Bit",
    apple_pay: "Apple Pay",
    google_pay: "Google Pay",
    transfer: "Bank transfer",
    cash: "Cash",
    cheque: "Cheque",
    other: "Other",
  },
} as const;

type MethodKey = keyof (typeof PAYMENT_METHOD_TEXT)["en"];

function methodKey(provider: string, method: string | null): MethodKey {
  if (provider === "PAYPAL") return "paypal";
  const m = (method ?? "").toLowerCase();
  if (m in PAYMENT_METHOD_TEXT.en) return m as MethodKey;
  return provider === "OFFLINE" ? "other" : "card";
}

export async function loadDisclosureInput(
  orderOrId: string | Order,
  locale: Locale,
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<DisclosureInput> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  let order: Order | undefined;
  if (typeof orderOrId === "string") {
    [order] = await db.select().from(orders).where(eq(orders.id, orderOrId));
  } else {
    order = orderOrId;
  }
  if (!order) throw new NotFoundError("order", String(orderOrId));

  const [items, profile, checkout, policy] = [
    await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.createdAt)),
    await getSetting("business_profile", db),
    await getSetting("checkout", db),
    await getSetting("cancellation_policy", db),
  ];
  const [attempt] = order.paidAttemptId
    ? await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, order.paidAttemptId))
    : [];
  const quote = (order.shippingQuote ?? null) as ShippingQuoteResult | null;
  const international = order.shipCountry !== "IL";
  const link = (path: string) =>
    absoluteUrl(e.APP_URL, localePath(locale, path));

  return {
    seller: {
      legalName: profile.legalName,
      tradeName: profile.tradeName[locale],
      idNumber: profile.idNumber,
      vatMode: profile.vatMode,
      ...(profile.vatNumber ? { vatNumber: profile.vatNumber } : {}),
      address: profile.address[locale],
      phoneLocal: profile.phoneLocal,
      phoneIntl: profile.phoneIntl,
      email: profile.email,
    },
    works: items.map((i) => {
      const s = (i.snapshot ?? {}) as ItemSnapshot;
      return {
        title: locale === "he" ? i.titleHe : i.titleEn,
        inventoryNumber: s.inventoryNumber ?? "",
        artistName: profile.artistName[locale],
        yearCreated: s.yearCreated ?? null,
        mediumText:
          (locale === "he" ? s.mediumDetailHe : s.mediumDetailEn) ?? "",
        dimensions: {
          heightMm: s.heightMm ?? 0,
          widthMm: s.widthMm ?? 0,
          depthMm: s.depthMm ?? null,
        },
        framed: s.framed ?? false,
        signed: s.signed ?? false,
        coaIncluded: s.coaIncluded ?? false,
        priceMinor: i.priceMinor,
      };
    }),
    currency: order.currency,
    itemsTotalMinor: order.itemsTotalMinor,
    shippingMinor: order.shippingMinor,
    insuranceMinor: order.insuranceMinor,
    totalMinor: order.totalMinor,
    vatMinor: order.vatMinor,
    zeroRatedExport: international,
    shippingMethod: order.shippingMethod,
    deliveryEstimate:
      (quote && "estimate" in quote ? quote.estimate?.[locale] : undefined) ??
      "",
    destinationCountry: order.shipCountry,
    insured: Boolean(quote && "insured" in quote && quote.insured),
    maxInstallments:
      order.shipCountry === "IL" && order.currency === "ILS"
        ? checkout.maxInstallments
        : 1,
    changeOfMindFee: policy.changeOfMindFee,
    international,
    links: {
      terms: link(paths.legal("terms")),
      returns: link(paths.legal("returns")),
      privacy: link(paths.legal("privacy")),
      shipping: link(paths.legal("shipping")),
      cancel: link(paths.cancel(order.number)),
    },
    versions: {
      terms: order.termsVersion ?? LEGAL_VERSIONS.terms,
      returns: order.returnsVersion ?? LEGAL_VERSIONS.returns,
      privacy: order.privacyVersion ?? LEGAL_VERSIONS.privacy,
    },
    orderNumber: order.number,
    orderedAt: order.createdAt.toISOString(),
    paidAt: (order.paidAt ?? order.updatedAt).toISOString(),
    conversationTookPlace: order.conversationTookPlace ?? false,
    ...(attempt
      ? {
          paymentMethodText:
            PAYMENT_METHOD_TEXT[locale][
              methodKey(attempt.provider, attempt.method)
            ],
          ...(attempt.installments
            ? { installments: attempt.installments }
            : {}),
        }
      : {}),
  };
}

export async function loadDisclosure(
  orderOrId: string | Order,
  locale: Locale,
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<DisclosureDoc> {
  return buildDisclosure(
    await loadDisclosureInput(orderOrId, locale, deps),
    locale,
  );
}

/** Absolute buyer URLs of an order (`?k=` token). */
export function buyerOrderUrls(
  order: Pick<Order, "id" | "number" | "accessVersion">,
  locale: Locale,
  e: Env = defaultEnv,
) {
  const token = orderAccessToken(order.id, order.accessVersion);
  return {
    token,
    orderUrl: absoluteUrl(
      e.APP_URL,
      localePath(locale, paths.order(order.number, token)),
    ),
    disclosureUrl: absoluteUrl(
      e.APP_URL,
      localePath(locale, paths.printDisclosure(order.number, token)),
    ),
    receiptUrl: (docNumber: string) =>
      absoluteUrl(
        e.APP_URL,
        localePath(locale, paths.printReceipt(docNumber, token)),
      ),
  };
}
