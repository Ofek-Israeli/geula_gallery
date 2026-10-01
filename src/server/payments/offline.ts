import "server-only";
import type { Currency } from "@/lib/money";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";

/**
 * `recordOfflinePayment()` (spec §4.2 "Offline payments"; frozen contract): fresh admin session;
 * `amountMinor === order.total_minor && currency === order.currency` (else refused); inserts an
 * OFFLINE / MANUAL attempt with the order's `quote_version` and applies it. Refunds of offline
 * payments are always MANUAL_REQUIRED. Body: WS2.
 */
export type OfflinePaymentMethod =
  | "transfer"
  | "cash"
  | "cheque"
  | "bit"
  | "card"
  | "other";

export interface OfflinePaymentInput {
  method: OfflinePaymentMethod;
  amountMinor: number;
  currency: Currency;
  reference: string;
  receivedAt: Date;
}

export async function recordOfflinePayment(
  _orderId: string,
  _input: OfflinePaymentInput,
  _ctx: AdminContext,
): Promise<ServiceResult<{ attemptId: string }>> {
  return notImplemented("recordOfflinePayment", "WS2");
}
