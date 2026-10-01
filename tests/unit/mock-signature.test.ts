import { describe, expect, it } from "vitest";
import type { MockPayment } from "@/server/db/schema";
import {
  signMockPayload,
  verifiedFromMock,
  verifyMockSignature,
} from "@/server/payments/providers/mock";
import { mockWebhookBody, signMockWebhook } from "../helpers/mock-webhook";

/** Spec §10.1 `mock-signature`: the HMAC header, its 300 s tolerance, and the state map. */
const secret = "test-unit-mock-secret-0123456789";

describe("mock webhook signature", () => {
  const body = mockWebhookBody("mock_0123");
  const now = 1_790_000_000;

  it("accepts the test helper's signature and its own", () => {
    expect(
      verifyMockSignature(
        signMockWebhook(body, secret, now),
        body,
        secret,
        now,
      ),
    ).toBe(true);
    expect(
      verifyMockSignature(
        signMockPayload(body, secret, now),
        body,
        secret,
        now,
      ),
    ).toBe(true);
  });

  it("rejects a wrong secret, a changed body, a missing header and stale timestamps", () => {
    expect(
      verifyMockSignature(
        signMockWebhook(body, "test-other-secret-0123456789", now),
        body,
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyMockSignature(
        signMockWebhook(body, secret, now),
        `${body} `,
        secret,
        now,
      ),
    ).toBe(false);
    expect(verifyMockSignature(null, body, secret, now)).toBe(false);
    expect(verifyMockSignature("garbage", body, secret, now)).toBe(false);
    expect(
      verifyMockSignature(
        signMockWebhook(body, secret, now - 301),
        body,
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyMockSignature(
        signMockWebhook(body, secret, now - 300),
        body,
        secret,
        now,
      ),
    ).toBe(true);
  });
});

describe("mock state map", () => {
  const row = {
    id: "x",
    ref: "mock_1",
    attemptId: "a1",
    amountMinor: 1000,
    currency: "ILS",
    flow: "DIRECT",
    state: "OPEN",
    transactionId: null,
    refundedMinor: 0,
    captureRequestIds: [] as string[],
    refundRequestIds: [] as string[],
    returnUrl: "",
    cancelUrl: "",
    notifyUrl: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies MockPayment as MockPayment;

  it.each([
    ["OPEN", "pending", false],
    ["APPROVED", "requires_capture", true],
    ["PAID", "succeeded", true],
    ["REVIEW", "review", true],
    ["DECLINED", "failed", false],
    ["CANCELED", "canceled", false],
    ["REFUNDED", "refunded", true],
    ["PARTIALLY_REFUNDED", "partially_refunded", true],
  ] as const)("%s → %s", (state, verified, money) => {
    const vp = verifiedFromMock({ ...row, state });
    expect(vp.state).toBe(verified);
    expect(vp.amount !== null).toBe(money);
    expect(vp.echoedReference).toBe("a1");
    expect(vp.merchantRef).toBe("mock-merchant");
  });
});
