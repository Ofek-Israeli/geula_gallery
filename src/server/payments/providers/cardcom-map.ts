import "server-only";
import type { Locale } from "@/lib/locale";
import { type Currency, fromDecimal, type Money, toMajor } from "@/lib/money";
import type { components } from "@/server/integrations/generated/cardcom";
import type {
  CreateCheckoutInput,
  GatewayDocumentSpec,
  ListedTransaction,
  VerifiedPayment,
} from "../types";

/**
 * Pure Cardcom LowProfile v11 mapping (spec §4.2 `cardcom`, §10.1 `cardcom-map`). No I/O: the
 * adapter in `cardcom.ts` sends what these build and maps what comes back.
 *
 * - `buildCreateRequest`: `LowProfile/Create` body (ReturnValue = attempt id, ISOCoinId, Amount in
 *   major units, installments only for IL + ILS + `maxInstallments > 1`, buyer prefill only in
 *   LIVE mode, `Document` only in gateway mode).
 * - `mapGetLpResult`: `succeeded` only when ResponseCode 0, Operation ChargeOnly,
 *   TranzactionInfo.ResponseCode 0 and TranzactionId > 0; **everything else is `pending`**.
 * - `redactCardcom`: drops CardOwner*, Token*, UIValues, CardInfo, card digits other than the last
 *   4, credentials and document buyer fields.
 * - `parseListTransactions`, `buildRefundRequest`, `notificationEventKey`.
 */

type Schemas = components["schemas"];
export type CardcomCreateRequest = Schemas["CreateLowProfile"];
export type CardcomCreateResponse = Schemas["CreateLowProfileResponse"];
export type CardcomLpResult = Schemas["LowProfileResult"];
export type CardcomTransactionInfo = Schemas["TransactionInfo"];
export type CardcomRefundRequest = Schemas["RefundByTransactionIdReq"];
export type CardcomRefundResponse = Schemas["RefundByTransactionIdResp"];
export type CardcomListTransactionsRequest = Schemas["ListTransactionsReq"];

/** Cardcom coin ids (`ISOCoinId` / `CoinId`): 1 = ILS, 2 = USD. */
export const CARDCOM_COIN_ID = { ILS: 1, USD: 2 } as const satisfies Record<
  Currency,
  number
>;

export function currencyFromCoinId(
  coinId: number | null | undefined,
): Currency | null {
  if (coinId === 1 || coinId === 376) return "ILS";
  if (coinId === 2 || coinId === 840) return "USD";
  return null;
}

/** Cardcom amounts are decimal numbers in major units; more than 2 decimals → null (rejected). */
export function cardcomAmountToMinor(amount: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return null;
  }
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  try {
    return fromDecimal((rounded / 100).toFixed(2));
  } catch {
    return null;
  }
}

/** Minor units → the major-unit number Cardcom expects (`4550` → `45.5`). */
export function minorToCardcomAmount(amountMinor: number): number {
  return toMajor(amountMinor);
}

const PRODUCT_PREFIX: Record<Locale, string> = {
  he: "ציור מקורי",
  en: "Original painting",
};

/** "Original painting – <title> (<orderNumber>)": artwork titles only, never buyer data. */
export function cardcomProductName(i: {
  lines: { name: string }[];
  orderNumber: string;
  locale: Locale;
}): string {
  const titles = i.lines
    .map((l) => l.name.trim())
    .filter(Boolean)
    .join(", ");
  const head = `${PRODUCT_PREFIX[i.locale]} – ${titles || i.orderNumber}`;
  const tail = ` (${i.orderNumber})`;
  const max = 200;
  return head.length + tail.length > max
    ? `${head.slice(0, max - tail.length - 1)}…${tail}`
    : `${head}${tail}`;
}

/** Installments only for an Israeli destination paying ILS with `maxInstallments > 1`. */
export function cardcomMaxPayments(
  i: Pick<CreateCheckoutInput, "shipTo" | "amount" | "maxInstallments">,
): number {
  const destination = i.shipTo?.country ?? "IL";
  return destination === "IL" &&
    i.amount.currency === "ILS" &&
    i.maxInstallments > 1
    ? Math.floor(i.maxInstallments)
    : 1;
}

export interface CardcomCreateConfig {
  terminalNumber: number;
  apiName: string;
  mode: "TEST" | "LIVE";
  threeDSecure: "Enabled" | "Disabled" | "Auto";
}

/**
 * The `LowProfile/Create` body. Nullable-but-required fields of the generated type are set to
 * `null` here and removed by `stripNulls` before sending, so Cardcom applies its own defaults.
 * In TEST mode no buyer data is sent at all (the shared public test terminal).
 */
export function buildCreateRequest(
  i: CreateCheckoutInput,
  cfg: CardcomCreateConfig,
): CardcomCreateRequest {
  const buyer = cfg.mode === "LIVE" ? i.buyer : null;
  return {
    TerminalNumber: cfg.terminalNumber,
    ApiName: cfg.apiName,
    Operation: "ChargeOnly",
    ReturnValue: i.attemptId,
    Amount: minorToCardcomAmount(i.amount.amountMinor),
    ISOCoinId: CARDCOM_COIN_ID[i.amount.currency],
    Language: i.locale,
    SuccessRedirectUrl: i.returnUrl,
    FailedRedirectUrl: i.failUrl,
    CancelRedirectUrl: i.cancelUrl,
    WebHookUrl: i.notifyUrl,
    ProductName: cardcomProductName(i),
    AdvancedDefinition: {
      ThreeDSecureState: cfg.threeDSecure,
      MaxNumOfPayments: cardcomMaxPayments(i),
      MinNumOfPayments: null,
      SelectedNumOfPayments: null,
      JValidateType: null,
      IsAVSEnable: null,
      CreditType: null,
      IsRefundDeal: null,
      CardNumber: null,
      CVV: null,
      IsExternal: null,
    },
    UIDefinition: buyer
      ? {
          CardOwnerNameValue: buyer.name,
          CardOwnerEmailValue: buyer.email,
          ...(buyer.phone ? { CardOwnerPhoneValue: buyer.phone } : {}),
          CardOwnerIdValue: null,
          IsHideCardOwnerName: null,
          IsHideCardOwnerPhone: null,
          IsCardOwnerPhoneRequired: null,
          IsHideCardOwnerEmail: null,
          IsCardOwnerEmailRequired: null,
          IsHideCardOwnerIdentityNumber: null,
          IsHideCVV: null,
        }
      : null,
    Document:
      i.gatewayDocument && cfg.mode === "LIVE"
        ? buildCardcomDocument(i.gatewayDocument)
        : null,
  };
}

/** Gateway-mode `Document` block (spec §4.3 `gateway`). */
export function buildCardcomDocument(
  d: GatewayDocumentSpec,
): NonNullable<CardcomCreateRequest["Document"]> {
  return {
    DocumentTypeToCreate: d.documentType,
    Name: d.name,
    ...(d.email && d.sendByEmail ? { Email: d.email } : {}),
    IsSendByEmail: d.sendByEmail && !!d.email,
    IsVatFree: d.vatFree,
    ...(d.taxId ? { TaxId: d.taxId } : {}),
    Products: d.products.map((p) => ({
      Description: p.description,
      Quantity: p.quantity,
      UnitCost: minorToCardcomAmount(p.unitPriceMinor),
      TotalLineCost: null,
      IsVatFree: d.vatFree,
      IsGiftCard: false,
    })),
    ExternalId: d.externalId,
    Language: d.language,
    IsAllowEditDocument: false,
    IsShowOnlyDocument: false,
  };
}

/** Deep copy without `null` / `undefined` members (Cardcom then uses its defaults). */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------- GetLpResult

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** The wallet behind an `ExternalPaymentVector`, when it names one. */
function walletOf(vector: unknown): string | null {
  const v = typeof vector === "string" ? vector.toLowerCase() : "";
  if (!v) return null;
  if (v.includes("bit")) return "bit";
  if (v.includes("apple")) return "apple_pay";
  if (v.includes("google")) return "google_pay";
  if (v.includes("paypal")) return "paypal";
  return null;
}

/**
 * `GetLpResult` (or a webhook body, which has the same shape) → `VerifiedPayment`. Verification
 * fields (`echoedReference`, `merchantRef`) are always returned; payment details only on success.
 */
export function mapGetLpResult(raw: unknown): VerifiedPayment {
  const r = asRecord(raw) as CardcomLpResult;
  const tx = asRecord(r.TranzactionInfo) as CardcomTransactionInfo;
  const echoedReference =
    typeof r.ReturnValue === "string" && r.ReturnValue ? r.ReturnValue : null;
  const terminal = r.TerminalNumber ?? tx.TerminalNumber;
  const merchantRef =
    typeof terminal === "number" && terminal > 0 ? String(terminal) : null;
  const rawRedacted = redactCardcom(raw);

  const tranzactionId = r.TranzactionId ?? tx.TranzactionId;
  const succeeded =
    r.ResponseCode === 0 &&
    r.Operation === "ChargeOnly" &&
    !!r.TranzactionInfo &&
    tx.ResponseCode === 0 &&
    typeof tranzactionId === "number" &&
    tranzactionId > 0;
  if (!succeeded) {
    return {
      state: "pending",
      amount: null,
      echoedReference,
      merchantRef,
      rawRedacted,
    };
  }

  const minor = cardcomAmountToMinor(tx.Amount);
  const currency = currencyFromCoinId(tx.CoinId);
  // An unparseable amount or unknown coin leaves `amount` null: finalize treats that as a
  // mismatch (money moved, but not verifiably the amount we asked for).
  const amount: Money | null =
    minor !== null && currency ? { amountMinor: minor, currency } : null;
  const last4 =
    tx.Last4CardDigitsString?.trim() ||
    (typeof tx.Last4CardDigits === "number" && tx.Last4CardDigits > 0
      ? String(tx.Last4CardDigits).padStart(4, "0")
      : undefined);
  const installments =
    typeof tx.NumberOfPayments === "number" && tx.NumberOfPayments > 0
      ? tx.NumberOfPayments
      : undefined;
  const doc = asRecord(r.DocumentInfo) as Schemas["DocumentInfo"];
  const gatewayDocument =
    doc.ResponseCode === 0 &&
    typeof doc.DocumentNumber === "number" &&
    doc.DocumentNumber > 0
      ? {
          type: String(doc.DocumentType ?? "Unknown"),
          number: String(doc.DocumentNumber),
          ...(doc.DocumentUrl ? { url: doc.DocumentUrl } : {}),
        }
      : undefined;
  const isForeignCard =
    typeof tx.IsAbroadCard === "boolean"
      ? tx.IsAbroadCard
      : tx.CardInfo
        ? tx.CardInfo === "NonIsraeli"
        : undefined;

  return {
    state: "succeeded",
    amount,
    echoedReference,
    merchantRef,
    transactionId: String(tranzactionId),
    method: walletOf(r.ExternalPaymentVector) ?? "card",
    ...(installments ? { installments } : {}),
    ...(last4 ? { last4 } : {}),
    ...(tx.Brand ? { brand: tx.Brand } : {}),
    ...(isForeignCard !== undefined ? { isForeignCard } : {}),
    ...(tx.ApprovalNumber ? { approvalCode: tx.ApprovalNumber } : {}),
    ...(gatewayDocument ? { gatewayDocument } : {}),
    rawRedacted,
  };
}

// ---------------------------------------------------------------- redaction

const DROP_KEY =
  /^(CardOwner|Token|UIValues$|CardInfo$|CardNumber|CVV|FirstCardDigits$|CardMonth$|CardYear$|ApiName$|ApiPassword$|UserName$|UserPassword$|Password$|Email$|Mobile$|Phone$|Name$|TaxId$|AddressLine|City$|CustomFields$)/i;

/**
 * Stored/logged form of a Cardcom payload (deep copy): drops card-owner data, tokens, UI values,
 * card info, card digits other than the last 4, credentials and document buyer fields.
 */
export function redactCardcom(raw: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED]";
  if (Array.isArray(raw)) return raw.map((v) => redactCardcom(v, depth + 1));
  if (raw === null || typeof raw !== "object") return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (DROP_KEY.test(k)) continue;
    out[k] = redactCardcom(v, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------- notifications

/** `cc:<LowProfileId>:<TranzactionId|none>:<ResponseCode>` (spec §4.2). */
export function notificationEventKey(raw: unknown): string {
  const r = asRecord(raw);
  const tx = asRecord(r.TranzactionInfo);
  const lp =
    typeof r.LowProfileId === "string" && r.LowProfileId
      ? r.LowProfileId
      : "unknown";
  const tranId = r.TranzactionId ?? tx.TranzactionId;
  const tranPart =
    typeof tranId === "number" && tranId > 0
      ? String(tranId)
      : typeof tranId === "string" && /^[1-9]\d*$/.test(tranId)
        ? tranId
        : "none";
  const code =
    typeof r.ResponseCode === "number" ||
    (typeof r.ResponseCode === "string" && r.ResponseCode !== "")
      ? String(r.ResponseCode)
      : "na";
  return `cc:${lp}:${tranPart}:${code}`;
}

/**
 * Parses a webhook body: JSON (v11) or, defensively, a form-encoded body. Never throws: an
 * unparseable body yields `{}` (finalization re-queries `GetLpResult` anyway).
 */
export function parseCardcomBody(rawBody: string): Record<string, unknown> {
  const text = rawBody.trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return {};
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    out[k] = /^-?\d{1,15}$/.test(v) ? Number(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------- refunds

export interface CardcomCredentials {
  apiName: string;
  apiPassword: string;
}

/** `RefundByTransactionId`: `AllowMultipleRefunds=false` for the first refund on a transaction. */
export function buildRefundRequest(
  i: {
    transactionId: string;
    amountMinor: number;
    isFull: boolean;
    priorRefunds: number;
  },
  creds: CardcomCredentials,
): CardcomRefundRequest {
  const transactionId = Number(i.transactionId);
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw new RangeError("Cardcom refunds need a numeric transaction id");
  }
  return {
    ApiName: creds.apiName,
    ApiPassword: creds.apiPassword,
    TransactionId: transactionId,
    ...(i.isFull ? {} : { PartialSum: minorToCardcomAmount(i.amountMinor) }),
    CancelOnly: false,
    AllowMultipleRefunds: i.priorRefunds > 0,
  };
}

// ---------------------------------------------------------------- ListTransactions

/** `DDMMYYYY` for the Israeli calendar day of `d` (the format the swagger documents). */
export function cardcomDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}${get("month")}${get("year")}`;
}

export function buildListTransactionsRequest(
  r: { from: Date; to: Date; page: number; pageSize: number },
  creds: CardcomCredentials,
): CardcomListTransactionsRequest {
  return {
    ApiName: creds.apiName,
    ApiPassword: creds.apiPassword,
    FromDate: cardcomDate(r.from),
    ToDate: cardcomDate(r.to),
    TranStatus: "Success",
    Page: r.page,
    Page_size: r.pageSize,
  };
}

/**
 * `ListTransactions` → successful charges (refund deals, failures and unparseable amounts are
 * skipped). `returnValue` / `lowProfileId` are read only when the response carries them (the
 * swagger's `TransactionInfo` does not); the sweep then matches by transaction id.
 */
export function parseListTransactions(raw: unknown): ListedTransaction[] {
  const r = asRecord(raw);
  const list = Array.isArray(r.Tranzactions) ? r.Tranzactions : [];
  const out: ListedTransaction[] = [];
  for (const item of list) {
    const t = asRecord(item);
    const id = t.TranzactionId;
    if (typeof id !== "number" || id <= 0) continue;
    if (t.IsRefund === true || t.DealType === "Refund") continue;
    if (typeof t.ResponseCode === "number" && t.ResponseCode !== 0) continue;
    const minor = cardcomAmountToMinor(t.Amount);
    const currency = currencyFromCoinId(t.CoinId as number | undefined);
    if (minor === null || !currency) continue;
    out.push({
      transactionId: String(id),
      amount: { amountMinor: minor, currency },
      ...(typeof t.ReturnValue === "string" && t.ReturnValue
        ? { returnValue: t.ReturnValue }
        : {}),
      ...(typeof t.LowProfileId === "string" && t.LowProfileId
        ? { lowProfileId: t.LowProfileId }
        : {}),
    });
  }
  return out;
}
