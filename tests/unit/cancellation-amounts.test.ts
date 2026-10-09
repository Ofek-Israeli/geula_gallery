import { describe, expect, it } from "vitest";
import {
  cancellationBase,
  cancellationRefund,
} from "@/lib/cancellation-amounts";
import { changeOfMindFee } from "@/lib/deadlines";

/**
 * Per-work cancellation amounts: the works' prices, shipping only with the last work, the fee on
 * that base under the order's shared ₪100 cap, and the refund clamped by what is still refundable.
 */
describe("cancellationBase", () => {
  const order = { orderItemsMinor: 600_000, paidMinor: 650_000 };

  it("a partial cancellation refunds the works only", () => {
    expect(
      cancellationBase({
        ...order,
        cancelledItemsMinor: 100_000,
        final: false,
      }),
    ).toEqual({
      itemsMinor: 100_000,
      shippingRefundMinor: 0,
      baseMinor: 100_000,
    });
  });

  it("the cancellation that leaves no work adds shipping and insurance", () => {
    expect(
      cancellationBase({ ...order, cancelledItemsMinor: 500_000, final: true }),
    ).toEqual({
      itemsMinor: 500_000,
      shippingRefundMinor: 50_000,
      baseMinor: 550_000,
    });
  });

  it("a whole-order cancellation is exactly what was paid", () => {
    expect(
      cancellationBase({ ...order, cancelledItemsMinor: 600_000, final: true })
        .baseMinor,
    ).toBe(650_000);
  });
});

describe("cancellationRefund", () => {
  it("is the base minus the fee", () => {
    expect(
      cancellationRefund(
        { baseMinor: 100_000, paidMinor: 650_000, alreadyRefundedMinor: 0 },
        5_000,
      ),
    ).toBe(95_000);
  });

  it("is clamped by what is still refundable (an earlier goodwill refund)", () => {
    expect(
      cancellationRefund(
        {
          baseMinor: 550_000,
          paidMinor: 650_000,
          alreadyRefundedMinor: 640_000,
        },
        0,
      ),
    ).toBe(10_000);
  });

  it("never goes below 0", () => {
    expect(
      cancellationRefund(
        {
          baseMinor: 100_000,
          paidMinor: 650_000,
          alreadyRefundedMinor: 650_000,
        },
        5_000,
      ),
    ).toBe(0);
  });

  it("matches the whole-order rule paid − already refunded − fee", () => {
    expect(
      cancellationRefund(
        {
          baseMinor: 650_000,
          paidMinor: 650_000,
          alreadyRefundedMinor: 20_000,
        },
        10_000,
      ),
    ).toBe(620_000);
  });
});

describe("the ₪100 cap is shared by the order", () => {
  const base = {
    regime: "IL" as const,
    reason: "CHANGE_OF_MIND" as const,
    currency: "ILS" as const,
    policy: "STATUTORY_MAX" as const,
  };

  it("an earlier fee lowers what is left of the cap", () => {
    expect(
      changeOfMindFee({
        ...base,
        totalPaidMinor: 1_000_000,
        alreadyWithheldMinor: 7_500,
      }).feeMinor,
    ).toBe(2_500);
  });

  it("nothing is left once ₪100 was withheld", () => {
    expect(
      changeOfMindFee({
        ...base,
        totalPaidMinor: 1_000_000,
        alreadyWithheldMinor: 10_000,
      }).feeMinor,
    ).toBe(0);
  });

  it("5% still applies below what is left", () => {
    expect(
      changeOfMindFee({
        ...base,
        totalPaidMinor: 40_000,
        alreadyWithheldMinor: 5_000,
      }).feeMinor,
    ).toBe(2_000);
  });
});
