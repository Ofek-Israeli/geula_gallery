/**
 * Consumer-law deadlines (spec §5.7 step 6, §3.6 COMPLETED rule). Pure functions.
 *
 * FROZEN SIGNATURES (spec §9.3). The bodies are owned by WS6 and intentionally throw until then;
 * every other `src/lib` module is fully implemented in M1. Calendar arithmetic must use the
 * Asia/Jerusalem helpers in `./format` (`addJerusalemDays`, `addJerusalemMonths`), which are
 * DST-safe.
 *
 * Rules to implement (spec §5.7):
 * - `windowStart = max(deliveredAt, disclosureSentAt ?? deliveredAt)`; before delivery there is
 *   no start yet, but a cancellation before delivery is valid (`beforeDelivery: true`).
 * - `windowEnd = windowStart + (eligibleGroup ≠ NONE && conversationTookPlace ? 4 months : 14 days)`.
 * - `refundDueAt = receivedAt + 14 days` (counted from the notice).
 * - Fee: IL regime and CHANGE_OF_MIND → `min(round(5 % × total paid), ₪100)`, converting ₪100 to
 *   USD with the order's locked FX for USD orders; otherwise 0.
 */
import type { Currency } from "./money";

export type EligibleGroup =
  | "NONE"
  | "SENIOR_65"
  | "DISABILITY"
  | "NEW_IMMIGRANT";
export type CancellationRegime = "IL" | "EU";
export type CancellationReasonValue =
  | "CHANGE_OF_MIND"
  | "DEFECT"
  | "NOT_AS_DESCRIBED"
  | "NOT_DELIVERED"
  | "OTHER";

/** The statutory cap on the change-of-mind fee, in ILS minor units (₪100). */
export const CHANGE_OF_MIND_FEE_CAP_ILS_MINOR = 10_000;
/** The statutory fee rate in basis points (5 %). */
export const CHANGE_OF_MIND_FEE_BP = 500;

export interface CancellationWindowInput {
  deliveredAt: Date | null;
  disclosureSentAt: Date | null;
  eligibleGroup: EligibleGroup;
  conversationTookPlace: boolean;
}

export interface CancellationWindow {
  /** Null while the order has not been delivered/collected yet. */
  start: Date | null;
  /** Null while `start` is null. */
  end: Date | null;
  length: "14_DAYS" | "4_MONTHS";
  /** True when there is no delivery yet: a cancellation is still valid (spec §5.7). */
  beforeDelivery: boolean;
}

export function cancellationWindow(
  _input: CancellationWindowInput,
): CancellationWindow {
  throw new Error("cancellationWindow is not implemented yet (owner: WS6)");
}

/** `receivedAt` + 14 Jerusalem calendar days (the legal refund deadline). */
export function refundDueAt(_receivedAt: Date): Date {
  throw new Error("refundDueAt is not implemented yet (owner: WS6)");
}

export interface ChangeOfMindFeeInput {
  regime: CancellationRegime;
  reason: CancellationReasonValue;
  /** What the buyer actually paid, in `currency` minor units. */
  totalPaidMinor: number;
  currency: Currency;
  /** The order's locked reference rate (`orders.fx_ils_per_unit`); required for USD. */
  ilsPerUsd?: number;
  /** `settings.cancellation_policy.changeOfMindFee`. */
  policy: "STATUTORY_MAX" | "NONE";
}

/** The suggested fee (the admin may only lower it), in the order's currency. */
export function changeOfMindFee(_input: ChangeOfMindFeeInput): {
  feeMinor: number;
  currency: Currency;
} {
  throw new Error("changeOfMindFee is not implemented yet (owner: WS6)");
}
