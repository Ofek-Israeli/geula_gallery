import "server-only";
import { z } from "zod";
import type { Locale } from "@/lib/locale";
import { type Currency, toMajor } from "@/lib/money";
import type { Env } from "@/server/env";
import type {
  components,
  paths,
} from "@/server/integrations/generated/morning";
import {
  createTypedClient,
  expectData,
  type FetchLike,
  instrumentedFetch,
  ProviderInvalidResponseError,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
} from "@/server/integrations/http";
import {
  type IssueCreditNoteInput,
  type IssuedDocument,
  type IssueReceiptInput,
  type TaxDocumentFactoryInput,
  TaxDocumentNeedsManualError,
  type TaxDocumentProvider,
  type TaxPaymentType,
} from "./types";

/**
 * Morning (Green Invoice) adapter (spec §4.3 "Morning"), on the generated Morning 2.0.0 types.
 *
 * - Token: `POST {auth}/idp/v1/oauth/token` (client_credentials), cached per (mode, client id)
 *   until 60 s before `expiresAt`; a 401 drops it and retries once.
 * - Receipts: `POST {api}/documents`, type **400** (osek patur receipt) or **320** (osek murshe tax
 *   invoice-receipt); `description` = the marker; `remarks` = order number + cancellation channel;
 *   `vatType` 0, or 1 (exempt) for zero-rated exports; `signed: true`; `client.add: false`.
 * - Payment rows: 3 card (last 4, installments), 5 PayPal, 10 app (appType 1 Bit / 6 Apple Pay /
 *   5 Google Pay), 4 transfer, 1 cash, 2 cheque, 11 other.
 * - Credit notes: type **330** linked to the receipt; when the original is a patur receipt (400)
 *   → `TaxDocumentNeedsManualError` (the contract carries no VAT mode, so the original document is
 *   read first).
 * - `findByMarker`: `POST /documents/search { description, fromDate, toDate }`, exact match on the
 *   description (the search is a text filter).
 * - `getPdf`: `GET /documents/{id}/download/links`, then the file itself.
 *
 * Pure builders are exported for the unit tests (`morning-map`).
 */
export const MORNING_BASES = {
  production: {
    api: "https://api.greeninvoice.co.il/api/v1",
    auth: "https://api.morning.co",
  },
  sandbox: {
    api: "https://sandbox.d.greeninvoice.co.il/api/v1",
    auth: "https://api.sandbox.morning.dev",
  },
} as const;

type Schemas = components["schemas"];
export type MorningCreateDocument = Schemas["CreateDocumentRequest"];
type IncomeRow = Schemas["IncomeRowRequest"];
type PaymentRow = Schemas["PaymentRowRequest"];

/** Morning document types used here. */
export const MORNING_DOC_TYPE = {
  RECEIPT: 400,
  TAX_INVOICE_RECEIPT: 320,
  CREDIT_NOTE: 330,
} as const;

/** Morning `PaymentGroup` codes. */
export const MORNING_PAYMENT_TYPE: Record<TaxPaymentType, number> = {
  cash: 1,
  cheque: 2,
  card: 3,
  transfer: 4,
  paypal: 5,
  bit: 10,
  apple_pay: 10,
  google_pay: 10,
  other: 11,
};

/** Morning `PaymentAppType` codes for app payments. */
export const MORNING_APP_TYPE: Partial<Record<TaxPaymentType, number>> = {
  bit: 1,
  google_pay: 5,
  apple_pay: 6,
};

/** Document-level `vatType`: 0 default (by business type), 1 exempt. */
export function morningDocumentVatType(i: {
  zeroRatedExport: boolean;
}): number {
  return i.zeroRatedExport ? 1 : 0;
}

/**
 * Row-level `vatType`: 0 default, 1 VAT included, 2 exempt. Our prices are VAT-inclusive for an
 * osek murshe; an osek patur charges none (default by business type); exports carry no VAT.
 * (Accountant to confirm, spec §12.3.)
 */
export function morningRowVatType(i: {
  vatMode: IssueReceiptInput["vatMode"];
  zeroRatedExport: boolean;
}): number {
  if (i.zeroRatedExport) return 2;
  return i.vatMode === "OSEK_MURSHE" ? 1 : 0;
}

/**
 * `currencyRate` is required by the generated type and means "rate relative to ILS". For ILS it
 * is 1; for other currencies it is omitted so Morning applies its own daily rate (to be confirmed
 * in the sandbox: spec §12.3 accountant item).
 */
function rate(currency: Currency): { currencyRate: number } {
  return (currency === "ILS" ? { currencyRate: 1 } : {}) as {
    currencyRate: number;
  };
}

const REMARKS: Record<Locale, (order: string, cancelUrl: string) => string> = {
  he: (order, url) => `הזמנה ${order}. ביטול עסקה: ${url}`,
  en: (order, url) => `Order ${order}. Cancellation: ${url}`,
};

export function buildReceiptRequest(
  i: IssueReceiptInput,
  opts: { cancelUrl: string },
): MorningCreateDocument {
  const rowVat = morningRowVatType(i);
  const income: IncomeRow[] = i.lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    price: toMajor(l.unitPriceMinor),
    currency: i.currency,
    ...rate(i.currency),
    vatType: rowVat,
  }));
  const p = i.payment;
  const typeCode = MORNING_PAYMENT_TYPE[p.type];
  const payment: PaymentRow = {
    date: p.date,
    type: typeCode,
    price: toMajor(p.amountMinor),
    currency: i.currency,
    ...rate(i.currency),
    ...(p.type === "card"
      ? {
          ...(p.last4 ? { cardNum: p.last4 } : {}),
          cardType: 0,
          dealType: p.installments && p.installments > 1 ? 2 : 1,
          ...(p.installments && p.installments > 1
            ? { numPayments: p.installments }
            : {}),
        }
      : {}),
    ...(typeCode === 10 && MORNING_APP_TYPE[p.type]
      ? { appType: MORNING_APP_TYPE[p.type] }
      : {}),
    ...(p.type !== "card" && p.reference ? { transactionId: p.reference } : {}),
  };
  return {
    description: i.marker,
    remarks: REMARKS[i.language](i.orderNumber, opts.cancelUrl),
    type:
      i.vatMode === "OSEK_PATUR"
        ? MORNING_DOC_TYPE.RECEIPT
        : MORNING_DOC_TYPE.TAX_INVOICE_RECEIPT,
    date: p.date,
    lang: i.language,
    currency: i.currency,
    vatType: morningDocumentVatType(i),
    rounding: false,
    signed: true,
    attachment: false,
    client: {
      name: i.client.companyName ?? i.client.name,
      country: i.client.country,
      ...(i.client.taxId ? { taxId: i.client.taxId } : {}),
      ...(i.client.address ? { address: i.client.address } : {}),
      add: false,
      self: false,
    },
    income,
    payment: [payment],
  };
}

export function buildCreditNoteRequest(
  i: IssueCreditNoteInput,
  original: {
    vatType?: number | null;
    clientName?: string | null;
    clientCountry?: string | null;
  },
): MorningCreateDocument {
  const exempt = original.vatType === 1;
  return {
    description: i.marker,
    remarks: i.reason,
    type: MORNING_DOC_TYPE.CREDIT_NOTE,
    lang: i.language,
    currency: i.currency,
    vatType: exempt ? 1 : 0,
    rounding: false,
    signed: true,
    attachment: false,
    ...(original.clientName
      ? {
          client: {
            name: original.clientName,
            country: original.clientCountry ?? "IL",
            add: false,
            self: false,
          },
        }
      : {}),
    income: [
      {
        description: i.reason,
        quantity: 1,
        price: toMajor(i.amountMinor),
        currency: i.currency,
        ...rate(i.currency),
        vatType: exempt ? 2 : 1,
      },
    ],
    linkedDocumentIds: [i.originalProviderDocId],
  };
}

const tokenSchema = z.looseObject({
  accessToken: z.string().min(1),
  expiresAt: z.number(),
});

const createdSchema = z.looseObject({
  id: z.string().min(1),
  number: z.union([z.number(), z.string()]),
  type: z.number(),
  url: z
    .looseObject({
      origin: z.string().optional(),
      he: z.string().optional(),
      en: z.string().optional(),
    })
    .optional(),
});

const searchSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      id: z.string(),
      number: z.union([z.number(), z.string()]),
      type: z.number(),
      description: z.string().optional(),
      status: z.number().optional(),
      documentDate: z.string().optional(),
      creationDate: z.number().optional(),
    }),
  ),
});

const documentSchema = z.looseObject({
  id: z.string(),
  type: z.number(),
  vatType: z.number().optional(),
  client: z
    .looseObject({
      name: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
});

const linksSchema = z.looseObject({
  he: z.string().optional(),
  en: z.string().optional(),
  origin: z.string().optional(),
});

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** Test hook: forget cached tokens. */
export function resetMorningTokenCache(): void {
  tokenCache.clear();
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function morningBases(env: Env) {
  return MORNING_BASES[env.MORNING_MODE === "live" ? "production" : "sandbox"];
}

export function createMorningTaxDocumentProvider({
  env,
  fetch,
}: TaxDocumentFactoryInput): TaxDocumentProvider {
  const bases = morningBases(env);
  const fetchImpl: FetchLike =
    fetch ?? ((request: Request) => globalThis.fetch(request));
  const api = createTypedClient<paths>({
    provider: "morning",
    baseUrl: bases.api,
    fetch: fetchImpl,
  });
  const auth = createTypedClient<paths>({
    provider: "morning",
    baseUrl: bases.auth,
    fetch: fetchImpl,
  });
  const fileFetch = instrumentedFetch("morning", fetchImpl, 30_000);
  const cacheKey = `${env.MORNING_MODE}:${env.MORNING_CLIENT_ID ?? ""}`;
  const cancelUrl = (locale: Locale) =>
    `${env.APP_URL.replace(/\/+$/, "")}/${locale}/cancel`;

  async function token(): Promise<string> {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    if (
      env.MORNING_MODE === "disabled" ||
      !env.MORNING_CLIENT_ID ||
      !env.MORNING_CLIENT_SECRET
    ) {
      throw new ProviderNotConfiguredError(
        "morning",
        "Morning client id and secret are required",
      );
    }
    const result = await auth.POST("/idp/v1/oauth/token", {
      body: {
        grant_type: "client_credentials",
        client_id: env.MORNING_CLIENT_ID,
        client_secret: env.MORNING_CLIENT_SECRET,
      },
    });
    const data = expectData("morning", result, tokenSchema);
    // `expiresAt` is a Unix timestamp in seconds; tolerate milliseconds.
    const expiresMs =
      data.expiresAt > 1e12 ? data.expiresAt : data.expiresAt * 1000;
    tokenCache.set(cacheKey, {
      token: data.accessToken,
      expiresAt: expiresMs - 60_000,
    });
    return data.accessToken;
  }

  async function authed<R extends { response: Response }>(
    call: (headers: { Authorization: string }) => Promise<R>,
  ): Promise<R> {
    const first = await call({ Authorization: `Bearer ${await token()}` });
    if (first.response.status !== 401) return first;
    tokenCache.delete(cacheKey);
    return call({ Authorization: `Bearer ${await token()}` });
  }

  async function create(body: MorningCreateDocument): Promise<IssuedDocument> {
    const result = await authed((headers) =>
      api.POST("/documents", { body, headers }),
    );
    const data = expectData("morning", result, createdSchema);
    return {
      providerDocId: data.id,
      docNumber: String(data.number),
      docTypeCode: String(data.type),
      ...(data.url?.origin ? { url: data.url.origin } : {}),
      issuedAt: new Date().toISOString(),
    };
  }

  return {
    id: "morning",

    issueReceipt(i) {
      return create(
        buildReceiptRequest(i, { cancelUrl: cancelUrl(i.language) }),
      );
    },

    async issueCreditNote(i) {
      const id = i.originalProviderDocId;
      const result = await authed((headers) =>
        api.GET("/documents/{id}", { params: { path: { id } }, headers }),
      );
      const original = expectData("morning", result, documentSchema);
      if (original.type === MORNING_DOC_TYPE.RECEIPT) {
        // Osek patur: a receipt cannot be credited with a 330 credit note (spec §4.3).
        throw new TaxDocumentNeedsManualError(
          "morning",
          "credit note for an osek patur receipt",
        );
      }
      return create(
        buildCreditNoteRequest(i, {
          vatType: original.vatType ?? null,
          clientName: original.client?.name ?? null,
          clientCountry: original.client?.country ?? null,
        }),
      );
    },

    async findByMarker(marker, around) {
      const day = 24 * 60 * 60 * 1000;
      const result = await authed((headers) =>
        api.POST("/documents/search", {
          body: {
            page: 1,
            pageSize: 50,
            description: marker,
            fromDate: isoDay(new Date(around.getTime() - 7 * day)),
            toDate: isoDay(new Date(around.getTime() + 7 * day)),
          },
          headers,
        }),
      );
      const data = expectData("morning", result, searchSchema);
      const hit = data.items.find((d) => d.description === marker);
      if (!hit) return null;
      return {
        providerDocId: hit.id,
        docNumber: String(hit.number),
        docTypeCode: String(hit.type),
        issuedAt:
          typeof hit.creationDate === "number"
            ? new Date(
                hit.creationDate > 1e12
                  ? hit.creationDate
                  : hit.creationDate * 1000,
              ).toISOString()
            : hit.documentDate
              ? new Date(`${hit.documentDate}T00:00:00Z`).toISOString()
              : new Date().toISOString(),
      };
    },

    async getPdf(providerDocId) {
      const result = await authed((headers) =>
        api.GET("/documents/{id}/download/links", {
          params: { path: { id: providerDocId } },
          headers,
        }),
      );
      const links = expectData("morning", result, linksSchema);
      const url = links.origin ?? links.he ?? links.en;
      if (!url) {
        throw new ProviderInvalidResponseError("morning", "no download link");
      }
      const response = await fileFetch(new Request(url));
      if (!response.ok) {
        throw new ProviderUnavailableError(
          "morning",
          `PDF download HTTP ${response.status}`,
          response.status,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
