import "server-only";
import type { VerifiedPayment } from "../types";
import { notConfigured } from "./stub";

/**
 * Pure PayPal mapping (spec §4.2 status table, §10.1 `paypal-map`): order/capture status →
 * VerifiedState, payee `merchant_id`, `custom_id`, `invoice_id`, payer-action link extraction.
 * M1 stub; WS5 implements.
 */
export function mapPaypalOrder(_order: unknown): VerifiedPayment {
  return notConfigured("paypal", "mapPaypalOrder");
}

export function payerActionUrl(_order: unknown): string {
  return notConfigured("paypal", "payerActionUrl");
}
