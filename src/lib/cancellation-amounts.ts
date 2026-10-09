/**
 * Amounts of a per-work cancellation (integer minor units in the order's currency). Pure.
 *
 * - Works: Σ the cancelled works' prices.
 * - Shipping and insurance (everything paid beyond the works) are refunded only by the cancellation
 *   that leaves no active work in the order; a partial cancellation keeps them (the remaining works
 *   still ship).
 * - The fee base is what this cancellation would refund before the fee (works + shipping refund).
 *   The change-of-mind fee is 5% of it, and all the fees withheld on one order share one ₪100 cap
 *   (`changeOfMindFee` with `alreadyWithheldMinor`).
 * - The refund is min(base, still refundable on the payment) − fee, never below 0: an earlier
 *   goodwill refund on the same payment is absorbed there.
 */
export interface CancellationBaseInput {
  /** Σ prices of the works this cancellation covers. */
  cancelledItemsMinor: number;
  /** Σ prices of every work of the order (cancelled or not). */
  orderItemsMinor: number;
  /** What was captured for the order. */
  paidMinor: number;
  /** True when no active work is left in the order after this cancellation. */
  final: boolean;
}

export interface CancellationBase {
  itemsMinor: number;
  shippingRefundMinor: number;
  /** itemsMinor + shippingRefundMinor: the fee base. */
  baseMinor: number;
}

export function cancellationBase(
  input: CancellationBaseInput,
): CancellationBase {
  const itemsMinor = Math.max(0, Math.trunc(input.cancelledItemsMinor));
  const shippingRefundMinor = input.final
    ? Math.max(0, Math.trunc(input.paidMinor - input.orderItemsMinor))
    : 0;
  return {
    itemsMinor,
    shippingRefundMinor,
    baseMinor: itemsMinor + shippingRefundMinor,
  };
}

/** The refund for a chosen fee: min(base, captured − already refunded) − fee, never below 0. */
export function cancellationRefund(
  input: { baseMinor: number; paidMinor: number; alreadyRefundedMinor: number },
  feeMinor: number,
): number {
  const refundable = Math.max(0, input.paidMinor - input.alreadyRefundedMinor);
  return Math.max(0, Math.min(input.baseMinor, refundable) - feeMinor);
}
