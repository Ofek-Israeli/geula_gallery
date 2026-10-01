import "server-only";
import { z } from "zod";
import type { paths } from "@/server/integrations/generated/cardcom";
import {
  createTypedClient,
  expectData,
  ProviderInvalidResponseError,
  ProviderNotConfiguredError,
  ProviderRejectedError,
} from "@/server/integrations/http";
import { verifyHmacToken } from "@/server/security/tokens";
import type {
  ListedTransaction,
  PaymentProvider,
  ProviderFactoryInput,
  Wallet,
} from "../types";
import {
  buildCreateRequest,
  buildListTransactionsRequest,
  buildRefundRequest,
  type CardcomCredentials,
  mapGetLpResult,
  notificationEventKey,
  parseCardcomBody,
  parseListTransactions,
  redactCardcom,
  stripNulls,
} from "./cardcom-map";

/**
 * Cardcom LowProfile v11 (spec §4.2 `cardcom`), on `CARDCOM_BASE_URL` with the generated swagger
 * types. Pure request/response mapping lives in `cardcom-map.ts`.
 *
 * - `createCheckout`: `LowProfile/Create` → `{ providerRef: LowProfileId, redirect: Url }`.
 *   Cardcom has no idempotency key: a retry creates a second LowProfile, which is harmless
 *   because only the attempt's stored `provider_ref` is ever verified.
 * - `fetchPayment`: `LowProfile/GetLpResult` (authoritative; everything but a verified charge is
 *   `pending`).
 * - Notifications are unsigned: the webhook URL carries `a=<attemptId>&t=<HMAC>` (HKDF purpose
 *   `cardcom-notify`), checked in constant time without the DB; the body is only a hint.
 * - `refund`: `Transactions/RefundByTransactionId` (needs `CARDCOM_API_PASSWORD`; without it →
 *   `manual_required`). ResponseCode 0 → succeeded; **any other code → `ProviderRejectedError`**,
 *   which the refund service records as FAILED (blocks retries until an admin confirms).
 * - `listTransactions`: `Transactions/ListTransactions` (needs the ApiPassword), paged.
 */
const WALLET_FROM_ENV = {
  bit: "bit",
  applepay: "apple_pay",
  googlepay: "google_pay",
} as const satisfies Record<string, Wallet>;

const createResponseSchema = z.looseObject({
  ResponseCode: z.number(),
  Description: z.string().nullish(),
  LowProfileId: z.string().nullish(),
  Url: z.string().nullish(),
});

const lpResultSchema = z.looseObject({ ResponseCode: z.number() });

const refundResponseSchema = z.looseObject({
  ResponseCode: z.number(),
  Description: z.string().nullish(),
  NewTranzactionId: z.number().nullish(),
});

const listResponseSchema = z.looseObject({
  ResponseCode: z.number(),
  Description: z.string().nullish(),
  Tranzactions: z.array(z.unknown()).nullish(),
});

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;

export function createCardcomProvider({
  env,
  fetch,
}: ProviderFactoryInput): PaymentProvider {
  const mode = env.CARDCOM_MODE === "live" ? "LIVE" : "TEST";
  const client = createTypedClient<paths>({
    provider: "cardcom",
    baseUrl: env.CARDCOM_BASE_URL.replace(/\/+$/, ""),
    ...(fetch ? { fetch } : {}),
    headers: { Accept: "application/json" },
  });

  const terminal = (): { terminalNumber: number; apiName: string } => {
    const terminalNumber = Number(env.CARDCOM_TERMINAL_NUMBER);
    if (
      env.CARDCOM_MODE === "disabled" ||
      !Number.isSafeInteger(terminalNumber) ||
      terminalNumber <= 0 ||
      !env.CARDCOM_API_NAME
    ) {
      throw new ProviderNotConfiguredError(
        "cardcom",
        "Cardcom terminal number and API name are required",
      );
    }
    return { terminalNumber, apiName: env.CARDCOM_API_NAME };
  };

  const credentials = (): CardcomCredentials | null =>
    env.CARDCOM_API_NAME && env.CARDCOM_API_PASSWORD
      ? { apiName: env.CARDCOM_API_NAME, apiPassword: env.CARDCOM_API_PASSWORD }
      : null;

  return {
    id: "cardcom",
    mode,
    capabilities: {
      currencies: [...env.CARDCOM_CURRENCIES],
      wallets: env.CARDCOM_WALLETS.map((w) => WALLET_FROM_ENV[w]),
      installments: true,
      notificationAuth: "unsigned-requery",
      requiresCapture: false,
      refunds: env.CARDCOM_API_PASSWORD ? "api" : "manual",
      partialRefunds: true,
      issuesTaxDocuments: env.TAX_DOCUMENTS_MODE === "gateway",
    },

    merchantRef() {
      if (!env.CARDCOM_TERMINAL_NUMBER) {
        throw new ProviderNotConfiguredError("cardcom", "no terminal number");
      }
      return env.CARDCOM_TERMINAL_NUMBER;
    },

    async authenticateNotification(n) {
      const attemptId = n.query.get("a");
      const token = n.query.get("t");
      if (!attemptId || !token) return false;
      return verifyHmacToken("cardcom-notify", attemptId, token);
    },

    parseNotification(n) {
      const body = parseCardcomBody(n.rawBody);
      const attemptId = n.query.get("a") ?? undefined;
      const lowProfileId =
        typeof body.LowProfileId === "string" && body.LowProfileId
          ? body.LowProfileId
          : undefined;
      return {
        eventKey: notificationEventKey(body),
        eventType: "LowProfile",
        ...(attemptId ? { attemptId } : {}),
        ...(lowProfileId ? { providerRef: lowProfileId } : {}),
        payloadRedacted: redactCardcom(body),
      };
    },

    async createCheckout(i) {
      if (!env.CARDCOM_CURRENCIES.includes(i.amount.currency)) {
        throw new ProviderRejectedError(
          "cardcom",
          `currency ${i.amount.currency} is not enabled for Cardcom`,
        );
      }
      const body = buildCreateRequest(i, {
        ...terminal(),
        mode,
        threeDSecure: env.CARDCOM_3DS,
      });
      const result = await client.POST("/api/v11/LowProfile/Create", {
        body: stripNulls(body),
      });
      const data = expectData("cardcom", result, createResponseSchema);
      if (data.ResponseCode !== 0) {
        throw new ProviderRejectedError(
          "cardcom",
          `LowProfile/Create refused (${data.ResponseCode})`,
          result.response.status,
          String(data.ResponseCode),
        );
      }
      if (!data.LowProfileId || !data.Url) {
        throw new ProviderInvalidResponseError(
          "cardcom",
          "LowProfile/Create returned no LowProfileId or Url",
          result.response.status,
        );
      }
      return {
        providerRef: data.LowProfileId,
        next: { kind: "redirect", url: data.Url },
      };
    },

    async fetchPayment(r) {
      const result = await client.POST("/api/v11/LowProfile/GetLpResult", {
        body: (() => {
          const t = terminal();
          return {
            TerminalNumber: t.terminalNumber,
            ApiName: t.apiName,
            LowProfileId: r.providerRef,
          };
        })(),
      });
      const data = expectData("cardcom", result, lpResultSchema);
      return mapGetLpResult(data);
    },

    async refund(i) {
      const creds = credentials();
      if (!creds) {
        return {
          status: "manual_required",
          rawRedacted: { reason: "no CARDCOM_API_PASSWORD" },
        };
      }
      const body = buildRefundRequest(
        {
          transactionId: i.transactionId,
          amountMinor: i.amount.amountMinor,
          isFull: i.isFull,
          priorRefunds: i.priorRefunds,
        },
        creds,
      );
      const result = await client.POST(
        "/api/v11/Transactions/RefundByTransactionId",
        { body },
      );
      const data = expectData("cardcom", result, refundResponseSchema);
      if (data.ResponseCode !== 0) {
        // Any non-zero code is FAILED (spec §4.2), including "already refunded" after a crash:
        // the FAILED row keeps counting toward the cap until an admin confirms in Cardcom.
        throw new ProviderRejectedError(
          "cardcom",
          `RefundByTransactionId refused (${data.ResponseCode})`,
          result.response.status,
          String(data.ResponseCode),
        );
      }
      return {
        status: "succeeded",
        ...(data.NewTranzactionId
          ? { providerRefundId: String(data.NewTranzactionId) }
          : {}),
        rawRedacted: redactCardcom(data),
      };
    },

    async listTransactions(r) {
      const creds = credentials();
      if (!creds) {
        throw new ProviderNotConfiguredError(
          "cardcom",
          "ListTransactions needs CARDCOM_API_PASSWORD",
        );
      }
      const out: ListedTransaction[] = [];
      for (let page = 1; page <= LIST_MAX_PAGES; page++) {
        const result = await client.POST(
          "/api/v11/Transactions/ListTransactions",
          {
            body: buildListTransactionsRequest(
              { from: r.from, to: r.to, page, pageSize: LIST_PAGE_SIZE },
              creds,
            ),
          },
        );
        const data = expectData("cardcom", result, listResponseSchema);
        if (data.ResponseCode !== 0) {
          throw new ProviderRejectedError(
            "cardcom",
            `ListTransactions refused (${data.ResponseCode})`,
            result.response.status,
            String(data.ResponseCode),
          );
        }
        out.push(...parseListTransactions(data));
        if ((data.Tranzactions?.length ?? 0) < LIST_PAGE_SIZE) return out;
      }
      throw new ProviderInvalidResponseError(
        "cardcom",
        `ListTransactions has more than ${LIST_MAX_PAGES} pages`,
      );
    },
  };
}
