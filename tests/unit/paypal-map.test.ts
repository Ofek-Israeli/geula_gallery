import { describe, expect, it } from "vitest";
import {
  mapPaypalOrder,
  mapRefundStatus,
  moneyFromPaypal,
  parsePaypalEvent,
  payerActionUrl,
  paypalInvoiceId,
  paypalMoney,
} from "@/server/payments/providers/paypal-map";
import { buildVerifyBody } from "@/server/payments/providers/paypal-verify";

/** Spec §10.1 `paypal-map`: states, payee match/mismatch, refund custom_id, invoice_id. */
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const usd = (value: string) => ({ currency_code: "USD", value });
const order = (status: string, payments?: unknown) => ({
  id: "O1",
  status,
  purchase_units: [
    {
      custom_id: ATTEMPT,
      invoice_id: "GG-1-1",
      amount: usd("340.00"),
      payee: { merchant_id: "M1", email_address: "seller@example.com" },
      ...(payments ? { payments } : {}),
    },
  ],
  payer: { email_address: "buyer@example.com" },
});
const capture = (status: string) => ({
  captures: [{ id: "C1", status, amount: usd("340.00"), custom_id: ATTEMPT }],
});

describe("mapPaypalOrder", () => {
  it("maps every order and capture status", () => {
    const cases: [unknown, string][] = [
      [order("CREATED"), "pending"],
      [order("SAVED"), "pending"],
      [order("PAYER_ACTION_REQUIRED"), "pending"],
      [order("APPROVED"), "requires_capture"],
      [order("VOIDED"), "canceled"],
      [order("COMPLETED", capture("COMPLETED")), "succeeded"],
      [order("COMPLETED", capture("PENDING")), "review"],
      [order("COMPLETED", capture("DECLINED")), "failed"],
      [order("COMPLETED", capture("FAILED")), "failed"],
      [order("COMPLETED", capture("REFUNDED")), "refunded"],
      [order("COMPLETED", capture("PARTIALLY_REFUNDED")), "partially_refunded"],
      [order("COMPLETED"), "review"],
      [{}, "pending"],
    ];
    for (const [raw, state] of cases)
      expect(mapPaypalOrder(raw).state).toBe(state);
  });

  it("returns custom_id, payee merchant_id, capture id and minor units", () => {
    expect(
      mapPaypalOrder(order("COMPLETED", capture("COMPLETED"))),
    ).toMatchObject({
      echoedReference: ATTEMPT,
      merchantRef: "M1",
      captureId: "C1",
      transactionId: "C1",
      amount: { amountMinor: 34_000, currency: "USD" },
      method: "paypal",
    });
  });

  it("sums completed refunds and keeps PII out of rawRedacted", () => {
    const vp = mapPaypalOrder(
      order("COMPLETED", {
        ...capture("PARTIALLY_REFUNDED"),
        refunds: [
          { id: "R1", status: "COMPLETED", amount: usd("100.00") },
          { id: "R2", status: "PENDING", amount: usd("50.00") },
        ],
      }),
    );
    expect(vp.refundedMinor).toBe(10_000);
    const stored = JSON.stringify(vp.rawRedacted);
    expect(stored).not.toContain("buyer@example.com");
    expect(stored).not.toContain("seller@example.com");
  });
});

describe("money, links and ids", () => {
  it("converts money both ways", () => {
    expect(paypalMoney({ amountMinor: 4550, currency: "ILS" })).toEqual({
      currency_code: "ILS",
      value: "45.50",
    });
    expect(moneyFromPaypal(usd("45.5"))).toEqual({
      amountMinor: 4550,
      currency: "USD",
    });
    expect(moneyFromPaypal(usd("45.555"))).toBeNull();
    expect(moneyFromPaypal({ currency_code: "EUR", value: "1.00" })).toBeNull();
  });

  it("extracts the payer-action link", () => {
    expect(
      payerActionUrl({
        links: [
          { rel: "self", href: "a" },
          { rel: "payer-action", href: "b" },
        ],
      }),
    ).toBe("b");
    expect(() => payerActionUrl({ links: [] })).toThrow();
  });

  it("invoice ids are unique per attempt", () => {
    expect(paypalInvoiceId("GG-1", 1)).not.toBe(paypalInvoiceId("GG-1", 2));
  });

  it("maps refund statuses", () => {
    expect(mapRefundStatus("COMPLETED")).toBe("succeeded");
    expect(mapRefundStatus("PENDING")).toBe("pending");
    expect(mapRefundStatus("FAILED")).toBe("failed");
    expect(mapRefundStatus("CANCELLED")).toBe("failed");
  });
});

describe("webhook events and verify body", () => {
  it("refund events carry our refund id as refundCustomId", () => {
    const hints = parsePaypalEvent(
      JSON.stringify({
        id: "WH-2",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        resource: {
          id: "R1",
          custom_id: "refund-1",
          payer: { email_address: "buyer@example.com" },
        },
      }),
    );
    expect(hints).toMatchObject({
      eventKey: "WH-2",
      refundCustomId: "refund-1",
    });
    expect(hints.attemptId).toBeUndefined();
    expect(JSON.stringify(hints.payloadRedacted)).not.toContain(
      "buyer@example.com",
    );
  });

  it("post-success events keep the capture link and the disputed capture ids only", () => {
    const refund = parsePaypalEvent(
      JSON.stringify({
        id: "WH-4",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        resource: {
          id: "R2",
          status: "COMPLETED",
          custom_id: "refund-2",
          amount: usd("10.00"),
          links: [
            {
              rel: "self",
              href: "https://api-m.paypal.com/v2/payments/refunds/R2",
            },
            {
              rel: "up",
              href: "https://api-m.paypal.com/v2/payments/captures/C9",
            },
          ],
        },
      }),
    );
    expect(refund.payloadRedacted).toMatchObject({
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "R2",
        status: "COMPLETED",
        custom_id: "refund-2",
        amount: usd("10.00"),
        links: [
          {
            rel: "up",
            href: "https://api-m.paypal.com/v2/payments/captures/C9",
          },
        ],
      },
    });
    const dispute = parsePaypalEvent(
      JSON.stringify({
        id: "WH-5",
        event_type: "CUSTOMER.DISPUTE.CREATED",
        resource_type: "dispute",
        resource: {
          id: "PP-D-9",
          status: "OPEN",
          disputed_transactions: [
            {
              seller_transaction_id: "C9",
              buyer: { name: "Buyer Example" },
            },
          ],
        },
      }),
    );
    expect(dispute.eventType).toBe("CUSTOMER.DISPUTE.CREATED");
    expect(dispute.attemptId).toBeUndefined();
    expect(dispute.payloadRedacted).toMatchObject({
      resource: { disputed_transactions: [{ seller_transaction_id: "C9" }] },
    });
    expect(JSON.stringify(dispute.payloadRedacted)).not.toContain("Buyer");
  });

  it("order events give the order id and attempt id", () => {
    expect(
      parsePaypalEvent(
        JSON.stringify({
          id: "WH-3",
          event_type: "CHECKOUT.ORDER.APPROVED",
          resource_type: "checkout-order",
          resource: { id: "O1", purchase_units: [{ custom_id: ATTEMPT }] },
        }),
      ),
    ).toMatchObject({ providerRef: "O1", attemptId: ATTEMPT });
    expect(parsePaypalEvent("not json").eventKey).toBe("unknown");
  });

  it("embeds the raw event verbatim and refuses incomplete input", () => {
    const headers = new Headers({
      "paypal-auth-algo": "A",
      "paypal-cert-url": "https://example.com/c",
      "paypal-transmission-id": "I",
      "paypal-transmission-sig": "S",
      "paypal-transmission-time": "T",
    });
    const raw = '{"id":"WH-1","n":1.10}';
    const body = buildVerifyBody({ headers, rawBody: raw, webhookId: "W" });
    expect(body).toBe(
      `{"auth_algo":"A","cert_url":"https://example.com/c","transmission_id":"I","transmission_sig":"S","transmission_time":"T","webhook_id":"W","webhook_event":${raw}}`,
    );
    expect(
      buildVerifyBody({ headers: new Headers(), rawBody: raw, webhookId: "W" }),
    ).toBeNull();
    expect(
      buildVerifyBody({ headers, rawBody: "[]", webhookId: "W" }),
    ).toBeNull();
    expect(
      buildVerifyBody({ headers, rawBody: raw, webhookId: "" }),
    ).toBeNull();
  });
});
