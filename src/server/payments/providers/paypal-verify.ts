import "server-only";

/**
 * PayPal webhook verification (spec §4.2 "Notifications"): the
 * `POST /v1/notifications/verify-webhook-signature` postback. Its body is built by **string
 * concatenation** so the raw event is embedded byte for byte: re-serializing a parsed event can
 * change number formatting or key order, and PayPal then answers FAILURE.
 *
 * Returns null when a transmission header is missing or the raw body is not one JSON object
 * (embedding anything else verbatim would let a caller inject extra fields).
 */
export const PAYPAL_TRANSMISSION_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export function buildVerifyBody(input: {
  headers: Headers;
  rawBody: string;
  webhookId: string;
}): string | null {
  const values: string[] = [];
  for (const [field, header] of Object.entries(PAYPAL_TRANSMISSION_HEADERS)) {
    const value = input.headers.get(header);
    if (!value) return null;
    values.push(`${JSON.stringify(field)}:${JSON.stringify(value)}`);
  }
  if (!input.webhookId) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return `{${values.join(",")},"webhook_id":${JSON.stringify(input.webhookId)},"webhook_event":${input.rawBody}}`;
}
