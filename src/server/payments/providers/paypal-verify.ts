import "server-only";
import { notConfigured } from "./stub";

/**
 * PayPal webhook verification (spec §4.2 "Notifications"): the verify-webhook-signature postback,
 * whose body is built by string concatenation so the raw event is embedded byte for byte.
 * M1 stub; WS5 implements.
 */
export function buildVerifyBody(_input: {
  headers: Headers;
  rawBody: string;
  webhookId: string;
}): string {
  return notConfigured("paypal", "buildVerifyBody");
}
