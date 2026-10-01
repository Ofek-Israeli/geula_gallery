/**
 * Consumer-law deadlines (spec §5.7 step 6, §3.6 COMPLETED rule). Pure functions.
 *
 * FROZEN SIGNATURES (spec §9.3); bodies by WS6. Calendar arithmetic uses the Asia/Jerusalem helpers
 * in `./format` (`addJerusalemDays`, `addJerusalemMonths`), which are DST-safe.
 *
 * Readings where the spec is open (buyer-favourable, flagged for the lawyer in
 * docs/painter-onboarding.md):
 * - the cancellation window ends at the **end** (23:59:59 Jerusalem) of the last calendar day;
 * - the refund deadline keeps the notice's wall-clock time, 14 Jerusalem calendar days later;
 * - the fee is rounded to the agorot/cent (half up) and the ₪100 cap is converted to USD with the
 *   locked rate and rounded **down** to the cent.
 *
 * Rules to implement (spec §5.7):
 * - `windowStart = max(deliveredAt, disclosureSentAt ?? deliveredAt)`; before delivery there is
 *   no start yet, but a cancellation before delivery is valid (`beforeDelivery: true`).
 * - `windowEnd = windowStart + (eligibleGroup ≠ NONE && conversationTookPlace ? 4 months : 14 days)`.
 * - `refundDueAt = receivedAt + 14 days` (counted from the notice).
 * - Fee: IL regime and CHANGE_OF_MIND → `min(round(5 % × total paid), ₪100)`, converting ₪100 to
 *   USD with the order's locked FX for USD orders; otherwise 0.
 */
import {
  addJerusalemDays,
  addJerusalemMonths,
  endOfJerusalemDay,
} from "./format";
import { applyBasisPoints, type Currency } from "./money";

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

/** 14 days, or 4 months for an eligible buyer after a conversation (spec §5.7 step 6). */
export function windowLength(
  eligibleGroup: EligibleGroup,
  conversationTookPlace: boolean,
): CancellationWindow["length"] {
  return eligibleGroup !== "NONE" && conversationTookPlace
    ? "4_MONTHS"
    : "14_DAYS";
}

export function cancellationWindow(
  input: CancellationWindowInput,
): CancellationWindow {
  const length = windowLength(input.eligibleGroup, input.conversationTookPlace);
  if (!input.deliveredAt) {
    return { start: null, end: null, length, beforeDelivery: true };
  }
  const disclosure = input.disclosureSentAt ?? input.deliveredAt;
  const start =
    disclosure.getTime() > input.deliveredAt.getTime()
      ? disclosure
      : input.deliveredAt;
  const lastDay =
    length === "4_MONTHS"
      ? addJerusalemMonths(start, 4)
      : addJerusalemDays(start, 14);
  return {
    start,
    end: endOfJerusalemDay(lastDay),
    length,
    beforeDelivery: false,
  };
}

/**
 * Whether a notice received at `receivedAt` is within the window. Before delivery it always is
 * (spec §5.7: a cancellation before delivery is valid).
 */
export function isWithinWindow(
  window: CancellationWindow,
  receivedAt: Date,
): boolean {
  return (
    window.beforeDelivery ||
    window.end === null ||
    receivedAt.getTime() <= window.end.getTime()
  );
}

/** `receivedAt` + 14 Jerusalem calendar days (the legal refund deadline). */
export function refundDueAt(receivedAt: Date): Date {
  return addJerusalemDays(receivedAt, 14);
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
export function changeOfMindFee(input: ChangeOfMindFeeInput): {
  feeMinor: number;
  currency: Currency;
} {
  const zero = { feeMinor: 0, currency: input.currency };
  if (
    input.policy === "NONE" ||
    input.regime !== "IL" ||
    input.reason !== "CHANGE_OF_MIND" ||
    input.totalPaidMinor <= 0
  ) {
    return zero;
  }
  const pct = applyBasisPoints(input.totalPaidMinor, CHANGE_OF_MIND_FEE_BP);
  let cap = CHANGE_OF_MIND_FEE_CAP_ILS_MINOR;
  if (input.currency === "USD") {
    const rate = input.ilsPerUsd;
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      throw new RangeError("ilsPerUsd is required for a USD fee");
    }
    // ₪100 in USD cents, rounded down (the buyer never pays more than ₪100).
    cap = Math.floor(
      (CHANGE_OF_MIND_FEE_CAP_ILS_MINOR * 1_000_000) /
        Math.round(rate * 1_000_000),
    );
  }
  return { feeMinor: Math.min(pct, cap), currency: input.currency };
}
