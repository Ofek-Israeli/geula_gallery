import "server-only";
import { z } from "zod";
import type { Env } from "@/server/env";
import type { paths as OrderPaths } from "@/server/integrations/generated/paypal-checkout-orders-v2";
import type { paths as PaymentPaths } from "@/server/integrations/generated/paypal-payments-v2";
import type { paths as WebhookPaths } from "@/server/integrations/generated/paypal-webhooks-v1";
import {
  createTypedClient,
  expectData,
  type FetchLike,
  instrumentedFetch,
  ProviderInvalidResponseError,
  ProviderNotConfiguredError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@/server/integrations/http";
import type {
  PaymentProvider,
  ProviderFactoryInput,
  VerifiedPayment,
} from "../types";
import {
  buildOrderRequest,
  buildRefundRequest,
  linkHref,
  mapPaypalOrder,
  mapRefundStatus,
  parsePaypalEvent,
  payerActionUrl,
  redactPaypalRefund,
} from "./paypal-map";
import { buildVerifyBody } from "./paypal-verify";

/**
 * PayPal Orders v2 with a full-page redirect to the `payer-action` link (spec §4.2 `paypal`).
 *
 * - OAuth client_credentials, cached per (mode, client id) until `expires_in - 60` s; a 401 on an
 *   API call drops the token and retries once (every mutating call carries a `PayPal-Request-Id`,
 *   so the retry is idempotent).
 * - `createCheckout`: `POST /v2/checkout/orders` (`PayPal-Request-Id` = the attempt's create
 *   request id), `intent CAPTURE`, `custom_id` = attempt id, `invoice_id` = `<order>-<seq>`.
 * - `fetchPayment`: `GET /v2/checkout/orders/{id}` (authoritative; `paypal-map.ts`).
 * - `capture`: `POST …/capture` with `PayPal-Request-Id` and `Prefer: return=representation`;
 *   ORDER_ALREADY_CAPTURED re-reads the order; a declined instrument maps to `failed`.
 * - `refund`: `POST /v2/payments/captures/{id}/refund` (`custom_id` = refund id).
 * - `getRefund`: `GET /v2/payments/refunds/{id}`, or, without a refund id, the order's refunds
 *   matched by `custom_id` (found through the capture's `up` link).
 * - Notifications: the verify-webhook-signature postback with the raw event embedded verbatim.
 */
export const PAYPAL_BASES = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Test hook: forget cached OAuth tokens. */
export function resetPaypalTokenCache(): void {
  tokenCache.clear();
}

const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const orderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
});

const refundSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
});

const verifySchema = z.looseObject({
  verification_status: z.string(),
});

/** "Geula Gallery <studio@…>" → "Geula Gallery" (shown on the PayPal page). */
export function brandNameFrom(emailFrom: string): string | undefined {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(emailFrom);
  return m?.[1]?.trim() || undefined;
}

function errorIssue(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) return undefined;
  const issue = (details[0] as { issue?: unknown } | undefined)?.issue;
  return typeof issue === "string" ? issue : undefined;
}

export function createPaypalProvider({
  env,
  fetch,
}: ProviderFactoryInput): PaymentProvider {
  const mode = env.PAYPAL_MODE === "live" ? "LIVE" : "TEST";
  const baseUrl = PAYPAL_BASES[env.PAYPAL_MODE === "live" ? "live" : "sandbox"];
  const fetchImpl: FetchLike =
    fetch ?? ((request: Request) => globalThis.fetch(request));
  const opts = { provider: "paypal" as const, baseUrl, fetch: fetchImpl };
  const orders = createTypedClient<OrderPaths>(opts);
  const payments = createTypedClient<PaymentPaths>(opts);
  const webhooks = createTypedClient<WebhookPaths>(opts);
  const tokenFetch = instrumentedFetch("paypal", fetchImpl, 15_000);
  const cacheKey = `${env.PAYPAL_MODE}:${env.PAYPAL_CLIENT_ID ?? ""}`;

  const credentials = (): { id: string; secret: string } => {
    if (
      env.PAYPAL_MODE === "disabled" ||
      !env.PAYPAL_CLIENT_ID ||
      !env.PAYPAL_CLIENT_SECRET
    ) {
      throw new ProviderNotConfiguredError(
        "paypal",
        "PayPal client id and secret are required",
      );
    }
    return { id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET };
  };

  async function accessToken(): Promise<string> {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const { id, secret } = credentials();
    const response = await tokenFetch(
      new Request(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      }),
    );
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    const parsed = expectData(
      "paypal",
      { data, error: data, response },
      tokenSchema,
    );
    tokenCache.set(cacheKey, {
      token: parsed.access_token,
      expiresAt: Date.now() + Math.max(0, parsed.expires_in - 60) * 1000,
    });
    return parsed.access_token;
  }

  /** Runs `call` with a bearer token; a 401 drops the cached token and retries once. */
  async function authed<R extends { response: Response }>(
    call: (headers: { Authorization: string }) => Promise<R>,
  ): Promise<R> {
    const first = await call({
      Authorization: `Bearer ${await accessToken()}`,
    });
    if (first.response.status !== 401) return first;
    tokenCache.delete(cacheKey);
    return call({ Authorization: `Bearer ${await accessToken()}` });
  }

  async function getOrder(id: string): Promise<VerifiedPayment> {
    const result = await authed((headers) =>
      orders.GET("/v2/checkout/orders/{id}", {
        params: { path: { id } },
        headers,
      }),
    );
    return mapPaypalOrder(expectData("paypal", result, orderSchema));
  }

  return {
    id: "paypal",
    mode,
    capabilities: {
      currencies: ["ILS", "USD"],
      wallets: [],
      installments: false,
      notificationAuth: "signature",
      requiresCapture: true,
      refunds: "api",
      partialRefunds: true,
      issuesTaxDocuments: false,
    },

    merchantRef() {
      if (!env.PAYPAL_MERCHANT_ID) {
        throw new ProviderNotConfiguredError("paypal", "no PAYPAL_MERCHANT_ID");
      }
      return env.PAYPAL_MERCHANT_ID;
    },

    async authenticateNotification(n) {
      if (!env.PAYPAL_WEBHOOK_ID) return false;
      const body = buildVerifyBody({
        headers: n.headers,
        rawBody: n.rawBody,
        webhookId: env.PAYPAL_WEBHOOK_ID,
      });
      if (!body) return false;
      const result = await authed((headers) =>
        webhooks.POST("/v1/notifications/verify-webhook-signature", {
          // The typed body is only a placeholder: `bodySerializer` sends the concatenated string.
          body: {} as never,
          bodySerializer: () => body,
          headers: { ...headers, "Content-Type": "application/json" },
        }),
      );
      const data = expectData("paypal", result, verifySchema);
      return data.verification_status === "SUCCESS";
    },

    parseNotification(n) {
      return parsePaypalEvent(n.rawBody);
    },

    async createCheckout(i) {
      const body = buildOrderRequest(i, {
        brandName: brandNameFrom(env.EMAIL_FROM),
      });
      const result = await authed((headers) =>
        orders.POST("/v2/checkout/orders", {
          body,
          headers: {
            ...headers,
            "PayPal-Request-Id": i.idemKey,
            Prefer: "return=minimal",
          },
        }),
      );
      const data = expectData("paypal", result, orderSchema);
      let url: string;
      try {
        url = payerActionUrl(data);
      } catch {
        throw new ProviderInvalidResponseError(
          "paypal",
          "order has no payer-action link",
          result.response.status,
        );
      }
      return { providerRef: data.id, next: { kind: "redirect", url } };
    },

    async fetchPayment(r) {
      return getOrder(r.providerRef);
    },

    async capture(r) {
      const result = await authed((headers) =>
        orders.POST("/v2/checkout/orders/{id}/capture", {
          params: { path: { id: r.providerRef } },
          headers: {
            ...headers,
            "PayPal-Request-Id": r.idemKey,
            Prefer: "return=representation",
          },
        }),
      );
      const status = result.response.status;
      if (status >= 400 && status < 500) {
        const issue = errorIssue(result.error);
        if (issue === "ORDER_ALREADY_CAPTURED") return getOrder(r.providerRef);
        if (status === 422) {
          const current = await getOrder(r.providerRef);
          // A declined instrument leaves the order APPROVED; the buyer is gone, so the attempt
          // fails (a new attempt can be started from the order page).
          if (current.state === "requires_capture") {
            return { ...current, state: "failed" };
          }
          return current;
        }
      }
      return mapPaypalOrder(expectData("paypal", result, orderSchema));
    },

    async refund(i) {
      const captureId = i.captureId ?? i.transactionId;
      const result = await authed((headers) =>
        payments.POST("/v2/payments/captures/{capture_id}/refund", {
          params: { path: { capture_id: captureId } },
          body: buildRefundRequest(i),
          headers: {
            ...headers,
            "PayPal-Request-Id": i.idemKey,
            Prefer: "return=representation",
          },
        }),
      );
      const data = expectData("paypal", result, refundSchema);
      const mapped = mapRefundStatus(data.status);
      if (mapped === "failed") {
        throw new ProviderRejectedError(
          "paypal",
          `refund ${String(data.status)}`,
          result.response.status,
          String(data.status),
        );
      }
      return {
        status: mapped === "succeeded" ? "succeeded" : "pending",
        providerRefundId: data.id,
        rawRedacted: redactPaypalRefund(data),
      };
    },

    async getRefund(r) {
      if (r.providerRefundId) {
        const id = r.providerRefundId;
        const result = await authed((headers) =>
          payments.GET("/v2/payments/refunds/{refund_id}", {
            params: { path: { refund_id: id } },
            headers,
          }),
        );
        if (result.response.status === 404) return { status: "not_found" };
        const data = expectData("paypal", result, refundSchema);
        return {
          status: mapRefundStatus(data.status),
          providerRefundId: data.id,
        };
      }
      if (!r.captureId) return { status: "not_found" };
      // No refund id stored (crash after the call): look for our custom_id on the order.
      const captureId = r.captureId;
      const cap = await authed((headers) =>
        payments.GET("/v2/payments/captures/{capture_id}", {
          params: { path: { capture_id: captureId } },
          headers,
        }),
      );
      const capture = expectData("paypal", cap, z.looseObject({}));
      const up = linkHref(capture, "up");
      const orderId = up
        ? /\/v2\/checkout\/orders\/([^/?#]+)/.exec(up)?.[1]
        : undefined;
      if (!orderId) {
        throw new ProviderUnavailableError(
          "paypal",
          "capture has no order link; cannot search refunds",
        );
      }
      const result = await authed((headers) =>
        orders.GET("/v2/checkout/orders/{id}", {
          params: { path: { id: orderId } },
          headers,
        }),
      );
      const order = expectData("paypal", result, orderSchema) as {
        purchase_units?: { payments?: { refunds?: unknown[] } }[];
      };
      const refunds = order.purchase_units?.[0]?.payments?.refunds ?? [];
      const match = refunds
        .map((x) => x as { id?: string; status?: string; custom_id?: string })
        .find((x) => x.custom_id === r.refundId);
      if (!match?.id) return { status: "not_found" };
      return {
        status: mapRefundStatus(match.status),
        providerRefundId: match.id,
      };
    },
  };
}

/** The env subset `check:paypal` prints (never secrets). */
export function paypalSummary(env: Env): Record<string, string> {
  return {
    mode: env.PAYPAL_MODE,
    base: PAYPAL_BASES[env.PAYPAL_MODE === "live" ? "live" : "sandbox"],
    webhookId: env.PAYPAL_WEBHOOK_ID ? "set" : "missing",
    merchantId: env.PAYPAL_MERCHANT_ID ? "set" : "missing",
  };
}
