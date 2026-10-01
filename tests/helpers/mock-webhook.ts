/**
 * Mock payment provider webhooks (spec §4.2 `mock`; frozen at contracts-v1).
 *
 * Body `{"id":"evt_<uuid>","type":"payment.updated","ref":"<ref>"}`, header
 * `x-mock-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`, 300 s tolerance.
 * Works from Vitest (real `fetch`) and Playwright (`request.post(url, { data: body, headers })`).
 */
import { createHmac, randomUUID } from "node:crypto";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export function mockWebhookBody(
  ref: string,
  opts: { id?: string; type?: string } = {},
): string {
  return JSON.stringify({
    id: opts.id ?? `evt_${randomUUID()}`,
    type: opts.type ?? "payment.updated",
    ref,
  });
}

/** `t=<unix>,v1=<hex>` for `rawBody`. `t` defaults to now (seconds). */
export function signMockWebhook(
  rawBody: string,
  secret: string,
  t: number = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

export interface MockWebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface MockWebhookOptions {
  /** e.g. `http://localhost:3100` */
  baseUrl: string;
  ref: string;
  secret: string;
  eventId?: string;
  /** Override the signature timestamp (seconds), e.g. to test the 300 s tolerance. */
  timestamp?: number;
  /** Sign with this secret instead (forged request). */
  signWith?: string;
  /** Send no signature header at all. */
  unsigned?: boolean;
}

/** Build (but do not send) a mock webhook request. */
export function buildMockWebhook(opts: MockWebhookOptions): MockWebhookRequest {
  const body = mockWebhookBody(opts.ref, { id: opts.eventId });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!opts.unsigned) {
    headers[MOCK_SIGNATURE_HEADER] = signMockWebhook(
      body,
      opts.signWith ?? opts.secret,
      opts.timestamp,
    );
  }
  return {
    url: `${opts.baseUrl.replace(/\/$/, "")}/api/payments/mock/webhook`,
    body,
    headers,
  };
}

/** POST a mock webhook with `fetch` and return the response. */
export async function postMockWebhook(
  opts: MockWebhookOptions,
): Promise<Response> {
  const req = buildMockWebhook(opts);
  return fetch(req.url, {
    method: "POST",
    body: req.body,
    headers: req.headers,
  });
}
