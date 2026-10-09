import "server-only";
import { cancellationRefund } from "@/lib/cancellation-amounts";
import {
  type CancellationReasonValue,
  type CancellationRegime,
  type CancellationWindow,
  cancellationWindow,
  changeOfMindFee,
  type EligibleGroup,
  isWithinWindow,
} from "@/lib/deadlines";
import type { Currency } from "@/lib/money";

/**
 * The legal assessment of a cancellation notice against its order (spec §5.7 steps 6–7). Pure:
 * callers pass the rows they already locked. The fee is a **suggestion**: the admin may only lower
 * it (`cancellation_policy.changeOfMindFee`, spec §4.7).
 */
export interface AssessmentInput {
  order: {
    deliveredAt: Date | null;
    disclosureSentAt: Date | null;
    conversationTookPlace: boolean;
    currency: Currency;
    /** `orders.fx_ils_per_unit` (numeric as string from pg). */
    fxIlsPerUnit: string | number | null;
  };
  /** What was captured for the order (the paid attempt's amount). */
  paidMinor: number;
  /**
   * What this cancellation refunds before the fee (`cancellationBase`: the cancelled works, plus
   * shipping when no work is left). Defaults to `paidMinor` (the whole order).
   */
  baseMinor?: number;
  /** Fees withheld by earlier cancellations of the order (the ₪100 cap is shared). */
  feesWithheldMinor?: number;
  /** Refund rows that already count against the capture (spec §3.3 cap rule). */
  alreadyRefundedMinor: number;
  regime: CancellationRegime;
  reason: CancellationReasonValue | null;
  eligibleGroup: EligibleGroup;
  receivedAt: Date;
  policy: "STATUTORY_MAX" | "NONE";
  /**
   * The admin grants the 4-month window although no conversation was recorded (spec §5.7 step 6:
   * the review defaults to granting it when eligibility is declared and the conversation is
   * uncertain).
   */
  grantFourMonths?: boolean;
}

export interface Assessment {
  window: CancellationWindow;
  withinWindow: boolean;
  /** Suggested (maximum) fee in the order currency. */
  suggestedFeeMinor: number;
  /** Refund for the suggested fee: min(base, paid − already refunded) − fee, never below 0. */
  refundAmountMinor: number;
  /** True when eligibility was declared but no conversation is on record. */
  conversationUncertain: boolean;
}

export function assessCancellation(input: AssessmentInput): Assessment {
  const conversation =
    input.order.conversationTookPlace ||
    (input.grantFourMonths === true && input.eligibleGroup !== "NONE");
  const window = cancellationWindow({
    deliveredAt: input.order.deliveredAt,
    disclosureSentAt: input.order.disclosureSentAt,
    eligibleGroup: input.eligibleGroup,
    conversationTookPlace: conversation,
  });
  const fx =
    input.order.fxIlsPerUnit === null
      ? undefined
      : Number(input.order.fxIlsPerUnit);
  const { feeMinor } = changeOfMindFee({
    regime: input.regime,
    reason: input.reason ?? "OTHER",
    totalPaidMinor: input.baseMinor ?? input.paidMinor,
    currency: input.order.currency,
    ...(fx && fx > 0 ? { ilsPerUsd: fx } : {}),
    policy: input.policy,
    alreadyWithheldMinor: input.feesWithheldMinor ?? 0,
  });
  return {
    window,
    withinWindow: isWithinWindow(window, input.receivedAt),
    suggestedFeeMinor: feeMinor,
    refundAmountMinor: refundFor(input, feeMinor),
    conversationUncertain:
      input.eligibleGroup !== "NONE" && !input.order.conversationTookPlace,
  };
}

/** The refund for a chosen fee (clamped to what is still refundable). */
export function refundFor(
  input: Pick<
    AssessmentInput,
    "paidMinor" | "alreadyRefundedMinor" | "baseMinor"
  >,
  feeMinor: number,
): number {
  return cancellationRefund(
    {
      baseMinor: input.baseMinor ?? input.paidMinor,
      paidMinor: input.paidMinor,
      alreadyRefundedMinor: input.alreadyRefundedMinor,
    },
    feeMinor,
  );
}

/** The fee the admin chose, never above the suggestion (spec §4.7: may only lower it). */
export function clampFee(requested: number | undefined, suggested: number) {
  if (requested === undefined || !Number.isFinite(requested)) return suggested;
  return Math.max(0, Math.min(Math.trunc(requested), suggested));
}
