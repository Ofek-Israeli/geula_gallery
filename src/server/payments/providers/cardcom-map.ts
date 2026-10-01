import "server-only";
import type { VerifiedPayment } from "../types";
import { notConfigured } from "./stub";

/**
 * Pure Cardcom mapping (spec §4.2 `fetchPayment`, §10.1 `cardcom-map`): GetLpResult → VerifiedPayment
 * (`succeeded` only when ResponseCode 0, Operation ChargeOnly, TranzactionInfo.ResponseCode 0 and
 * TranzactionId > 0; everything else `pending`), redaction (drops CardOwner*, Token, UIValues,
 * CardInfo) and ListTransactions parsing. M1 stub; WS5 implements.
 */
export function mapGetLpResult(_raw: unknown): VerifiedPayment {
  return notConfigured("cardcom", "mapGetLpResult");
}

export function redactCardcom(_raw: unknown): unknown {
  return notConfigured("cardcom", "redactCardcom");
}
