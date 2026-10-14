import "server-only";
import type { z } from "zod";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import {
  instrumentedFetch,
  ProviderInvalidResponseError,
  ProviderNotConfiguredError,
  ProviderRejectedError,
  ProviderUnavailableError,
  parseBodyText,
} from "@/server/integrations/http";
import { hmacToken, verifyHmacToken } from "@/server/security/tokens";
import type { HostedFieldsProvider, ProviderFactoryInput } from "../types";
import {
  buildGenerateSale,
  buildPaySale,
  buildRefundSale,
  callbackEventKey,
  generateSaleResponseSchema,
  isPendingSaleRef,
  listedTransactions,
  mapPaySale,
  mapTransactions,
  PAYME_API_BASE,
  PAYME_HOSTED_FIELDS_SCRIPT,
  parseCallbackBody,
  parseTransactions,
  paymeDateTime,
  paySaleResponseSchema,
  pendingSaleRef,
  redactCallback,
  refundResponseSchema,
  sellerFingerprint,
  transactionsResponseSchema,
} from "./isracard-map";

/**
 * Isracard's e-commerce service (it runs on PayMe): the card form is PayMe's hosted fields on our
 * own pay page, so card data never reaches our servers (PCI SAQ A, iframe). Mapping and the API
 * facts are in `isracard-map.ts`.
 *
 * - `createCheckout`: no network call; `provider_ref` is the placeholder `hf:<attemptId>` and the
 *   redirect is our pay page (`/checkout/pay/<attemptId>?t=<HMAC>`).
 * - `hostedFields.createSale` / `paySale`: `generate-sale` then `pay-sale` with the one-time token
 *   (`charge.ts` calls them once per attempt, never again for the same attempt).
 * - `fetchPayment`: `get-transactions` by our `transaction_id` (authoritative; the callback is only
 *   a hint). It also finds a sale whose id we never stored (a lost answer), for finalize to adopt.
 * - Callbacks are form-encoded and their signature scheme is not documented: the callback URL
 *   carries `a=<attemptId>&t=<HMAC>` (purpose `isracard-notify`), checked without the DB.
 * - `refund`: `refund-sale` needs the partner key (`ISRACARD_CLIENT_KEY`); without it →
 *   `manual_required` (refund in the PayMe dashboard).
 * - The mode alone picks sandbox or live; `ISRACARD_BASE_URL` / `ISRACARD_HF_SCRIPT_URL` exist for
 *   tests only (refused in production by `env.ts`).
 */
const TIMEOUT_MS = 20_000;

export function createIsracardProvider({
  env,
  fetch,
}: ProviderFactoryInput): HostedFieldsProvider {
  const mode = env.ISRACARD_MODE === "live" ? "LIVE" : "TEST";
  const baseUrl = (
    (!env.isProduction && env.ISRACARD_BASE_URL) ||
    PAYME_API_BASE[mode]
  ).replace(/\/+$/, "");
  const http = instrumentedFetch(
    "isracard",
    fetch ?? ((request: Request) => globalThis.fetch(request)),
    TIMEOUT_MS,
  );

  const sellerId = (): string => {
    if (env.ISRACARD_MODE === "disabled" || !env.ISRACARD_SELLER_ID) {
      throw new ProviderNotConfiguredError(
        "isracard",
        "Isracard seller id is required",
      );
    }
    return env.ISRACARD_SELLER_ID;
  };

  /**
   * One JSON POST. PayMe names business errors (missing data, a refused card) in the body, at
   * times with HTTP 500: those are refusals. A 5xx without one is unavailable, or unknown when the
   * call may have charged (`chargeCall`).
   */
  async function post<S extends z.ZodType>(
    path: string,
    body: Record<string, unknown>,
    schema: S,
    opts: { chargeCall?: boolean } = {},
  ): Promise<z.infer<S>> {
    const response = await http(
      new Request(`${baseUrl}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    const parsed = schema.safeParse(parseBodyText(await response.text()));
    const errorCode = parsed.success
      ? ((parsed.data as { status_error_code?: string | null })
          .status_error_code ?? null)
      : null;
    if (response.status >= 400) {
      if (errorCode) {
        throw new ProviderRejectedError(
          "isracard",
          `${path} refused (${errorCode})`,
          response.status,
          errorCode,
        );
      }
      if (response.status >= 500) {
        if (opts.chargeCall) {
          throw new ProviderInvalidResponseError(
            "isracard",
            `${path}: HTTP ${response.status}`,
            response.status,
          );
        }
        throw new ProviderUnavailableError(
          "isracard",
          `HTTP ${response.status}`,
          response.status,
        );
      }
      throw new ProviderRejectedError(
        "isracard",
        `${path}: HTTP ${response.status}`,
        response.status,
      );
    }
    if (!parsed.success) {
      throw new ProviderInvalidResponseError(
        "isracard",
        `${path}: unexpected response shape`,
        response.status,
      );
    }
    return parsed.data;
  }

  async function transactions(filter: Record<string, unknown>) {
    const data = await post(
      "get-transactions",
      { seller_payme_id: sellerId(), ...filter },
      transactionsResponseSchema,
    );
    if (data.status_code === 1) {
      throw new ProviderUnavailableError(
        "isracard",
        `get-transactions failed (${data.status_error_code ?? "1"})`,
      );
    }
    return parseTransactions(data.items);
  }

  return {
    id: "isracard",
    mode,
    capabilities: {
      currencies: [...env.ISRACARD_CURRENCIES],
      wallets: [],
      installments: true,
      notificationAuth: "unsigned-requery",
      requiresCapture: false,
      refunds: env.ISRACARD_CLIENT_KEY ? "api" : "manual",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },

    merchantRef() {
      return sellerFingerprint(sellerId());
    },

    async authenticateNotification(n) {
      const attemptId = n.query.get("a");
      const token = n.query.get("t");
      if (!attemptId || !token) return false;
      return verifyHmacToken("isracard-notify", attemptId, token);
    },

    parseNotification(n) {
      const body = parseCallbackBody(n.rawBody);
      const attemptId = n.query.get("a") ?? undefined;
      const saleId = body.get("payme_sale_id") || undefined;
      return {
        eventKey: callbackEventKey(body),
        eventType: body.get("notify_type") || "callback",
        ...(attemptId ? { attemptId } : {}),
        ...(saleId ? { providerRef: saleId } : {}),
        payloadRedacted: redactCallback(body),
      };
    },

    async createCheckout(i) {
      if (!env.ISRACARD_CURRENCIES.includes(i.amount.currency)) {
        throw new ProviderRejectedError(
          "isracard",
          `currency ${i.amount.currency} is not enabled for Isracard`,
        );
      }
      sellerId();
      const url = absoluteUrl(
        env.APP_URL,
        localePath(
          i.locale,
          paths.payPage(i.attemptId, hmacToken("isracard-pay", i.attemptId)),
        ),
      );
      return {
        providerRef: pendingSaleRef(i.attemptId),
        next: { kind: "redirect", url },
      };
    },

    async fetchPayment(r) {
      const saleId = isPendingSaleRef(r.providerRef) ? null : r.providerRef;
      let rows = await transactions({ transaction_id: r.attemptId });
      // If PayMe does not echo our transaction id, the sale we created for this attempt still
      // identifies it.
      if (rows.length === 0 && saleId) {
        rows = await transactions({ sale_payme_id: saleId });
      }
      return mapTransactions(rows, {
        attemptId: r.attemptId,
        saleId,
        sellerId: sellerId(),
      });
    },

    async refund(i) {
      const saleId =
        i.providerRef && !isPendingSaleRef(i.providerRef)
          ? i.providerRef
          : null;
      if (!env.ISRACARD_CLIENT_KEY || !saleId) {
        return {
          status: "manual_required",
          rawRedacted: {
            reason: !saleId ? "no sale id" : "no ISRACARD_CLIENT_KEY",
          },
        };
      }
      const data = await post(
        "refund-sale",
        buildRefundSale({
          clientKey: env.ISRACARD_CLIENT_KEY,
          sellerId: sellerId(),
          saleId,
          amountMinor: i.amount.amountMinor,
          isFull: i.isFull,
        }),
        refundResponseSchema,
      );
      const status = (data.sale_status ?? "").toLowerCase();
      if (
        data.status_code !== 0 ||
        (status !== "refunded" && status !== "partial-refund")
      ) {
        throw new ProviderRejectedError(
          "isracard",
          `refund-sale refused (${data.status_error_code ?? status ?? "1"})`,
          undefined,
          data.status_error_code ?? undefined,
        );
      }
      return {
        status: "succeeded",
        ...(data.payme_transaction_id
          ? { providerRefundId: data.payme_transaction_id }
          : {}),
        rawRedacted: { sale_status: data.sale_status ?? null },
      };
    },

    async listTransactions(r) {
      const day = 24 * 60 * 60_000;
      const rows = await transactions({
        transaction_created_min: paymeDateTime(
          new Date(r.from.getTime() - day),
        ),
        transaction_created_max: paymeDateTime(new Date(r.to.getTime() + day)),
      });
      // The window is widened by a day each way (PayMe's time zone); extra rows only match
      // attempts that already exist.
      return listedTransactions(rows);
    },

    hostedFields: {
      client() {
        if (!env.ISRACARD_JSAPI_KEY) {
          throw new ProviderNotConfiguredError(
            "isracard",
            "Isracard JSAPI key is required",
          );
        }
        return {
          apiKey: env.ISRACARD_JSAPI_KEY,
          testMode: mode === "TEST",
          scriptUrl:
            (!env.isProduction && env.ISRACARD_HF_SCRIPT_URL) ||
            PAYME_HOSTED_FIELDS_SCRIPT,
        };
      },

      async createSale(i) {
        const data = await post(
          "generate-sale",
          buildGenerateSale(i, sellerId(), mode),
          generateSaleResponseSchema,
        );
        if (data.status_code !== 0 || !data.payme_sale_id) {
          throw new ProviderRejectedError(
            "isracard",
            `generate-sale refused (${data.status_error_code ?? data.status_code ?? "?"})`,
            undefined,
            data.status_error_code ?? undefined,
          );
        }
        return { saleId: data.payme_sale_id };
      },

      async paySale(i) {
        try {
          const data = await post(
            "pay-sale",
            buildPaySale(i, sellerId()),
            paySaleResponseSchema,
            { chargeCall: true },
          );
          const mapped = mapPaySale(data);
          if (!mapped) {
            throw new ProviderInvalidResponseError(
              "isracard",
              "pay-sale: no usable status",
            );
          }
          return mapped;
        } catch (error) {
          if (error instanceof ProviderRejectedError) {
            return {
              kind: "declined",
              code: error.code ?? "rejected",
              message: error.message.slice(0, 200),
            };
          }
          throw error;
        }
      },
    },
  };
}
