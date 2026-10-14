import { describe, expect, it } from "vitest";
import {
  buildGenerateSale,
  buildPaySale,
  buildRefundSale,
  callbackEventKey,
  isPendingSaleRef,
  listedTransactions,
  mapPaySale,
  mapTransactions,
  type PaymeTransaction,
  parseCallbackBody,
  parseTransactions,
  pendingSaleRef,
  redactCallback,
  sellerFingerprint,
} from "@/server/payments/providers/isracard-map";
import type { CreateSaleInput } from "@/server/payments/types";

/** Isracard (PayMe) request/response mapping (docs.payme.io, read 2026-10-14). */
const ATTEMPT = "0d4f7a52-6a1e-4c1e-9b8e-0f6f6e6b8a11";
const SELLER = "MPL00000-TEST0000-TEST0000-TEST0000";

const sale: CreateSaleInput = {
  attemptId: ATTEMPT,
  amount: { amountMinor: 187_000, currency: "ILS" },
  productName: "GG-7K3M9Q · The Path",
  installments: 3,
  locale: "he",
  notifyUrl: "https://example.test/api/payments/isracard/webhook?a=x&t=y",
  returnUrl: "https://example.test/api/payments/isracard/return?a=x&s=success",
  cancelUrl: "https://example.test/api/payments/isracard/return?a=x&s=failed",
};

function row(over: Partial<PaymeTransaction> = {}): PaymeTransaction {
  return parseTransactions([
    {
      seller_payme_id: SELLER,
      sale_payme_id: "SALE1655-0000AAAA-BBBBCCCC-DDDDEEEE",
      transaction_id: ATTEMPT,
      payme_transaction_id: "TRAN1655-0000AAAA-BBBBCCCC-DDDDEEEE",
      sale_status: "completed",
      transaction_action: "Debit",
      transaction_type: 1,
      transaction_price: 187_000,
      sale_currency: "ILS",
      sale_installments: 3,
      sale_auth_number: "1172408",
      transaction_error_code: 20000,
      sale_is_3ds: true,
      sale_buyer_details: {
        buyer_card_mask: "532610******5846",
        buyer_card_brand: "Mastercard",
        buyer_card_is_foreign: false,
        buyer_name: "Test Buyer",
        buyer_social_id: "000000018",
      },
      ...over,
    },
  ])[0] as PaymeTransaction;
}

describe("isracard-map: requests", () => {
  it("generate-sale: minor units, our attempt id, installments, our return URLs, no buyer data", () => {
    const body = buildGenerateSale(sale, SELLER, "LIVE");
    expect(body).toMatchObject({
      seller_payme_id: SELLER,
      sale_price: 187_000,
      currency: "ILS",
      product_name: "GG-7K3M9Q · The Path",
      transaction_id: ATTEMPT,
      installments: "3",
      sale_type: "sale",
      sale_payment_method: "credit-card",
      sale_callback_url: sale.notifyUrl,
      sale_return_url: sale.returnUrl,
      cancel_url: sale.cancelUrl,
      sale_send_notification: false,
      language: "he",
    });
    expect(JSON.stringify(body)).not.toMatch(/buyer_|@/);
    expect(buildGenerateSale(sale, SELLER, "TEST").product_name).toBe(
      "TEST – GG-7K3M9Q · The Path",
    );
  });

  it("pay-sale: the one-time token and client data; buyer details only when given", () => {
    const body = buildPaySale(
      {
        ...sale,
        saleId: "SALE-1",
        buyerKey: "BUYER-1",
        clientData: "jwt-1",
        buyer: null,
        socialId: null,
      },
      SELLER,
    );
    expect(body).toMatchObject({
      payme_sale_id: "SALE-1",
      buyer_key: "BUYER-1",
      meta_data_jwt: "jwt-1",
      sale_price: "187000",
      installments: "3",
      capture_buyer: 0,
    });
    expect(body).not.toHaveProperty("buyer_email");
    expect(body).not.toHaveProperty("buyer_social_id");
    const live = buildPaySale(
      {
        ...sale,
        saleId: "SALE-1",
        buyerKey: "BUYER-1",
        clientData: null,
        buyer: { name: "Test Buyer", email: "buyer@example.test" },
        socialId: "000000018",
      },
      SELLER,
    );
    expect(live).toMatchObject({
      buyer_name: "Test Buyer",
      buyer_email: "buyer@example.test",
      buyer_social_id: "000000018",
    });
    expect(live).not.toHaveProperty("meta_data_jwt");
  });

  it("refund-sale: full refunds send no amount, partial ones do", () => {
    const base = {
      clientKey: "client-key",
      sellerId: SELLER,
      saleId: "SALE-1",
      amountMinor: 50_000,
    };
    expect(buildRefundSale({ ...base, isFull: true })).not.toHaveProperty(
      "sale_refund_amount",
    );
    expect(buildRefundSale({ ...base, isFull: false })).toMatchObject({
      sale_refund_amount: 50_000,
      payme_sale_id: "SALE-1",
    });
  });

  it("the placeholder ref and the seller fingerprint", () => {
    expect(pendingSaleRef(ATTEMPT)).toBe(`hf:${ATTEMPT}`);
    expect(isPendingSaleRef(pendingSaleRef(ATTEMPT))).toBe(true);
    expect(isPendingSaleRef("SALE-1")).toBe(false);
    expect(isPendingSaleRef(null)).toBe(false);
    const fp = sellerFingerprint(SELLER);
    expect(fp).toMatch(/^mpl:[0-9a-f]{16}$/);
    expect(fp).not.toContain(SELLER);
    expect(sellerFingerprint(SELLER)).toBe(fp);
    expect(sellerFingerprint(`${SELLER}x`)).not.toBe(fp);
  });
});

describe("isracard-map: pay-sale answers", () => {
  it("maps completed, challenge, declined and unreadable answers", () => {
    expect(mapPaySale({ status_code: 0, sale_status: "completed" })).toEqual({
      kind: "completed",
    });
    expect(
      mapPaySale({
        status_code: 5,
        redirect_url: "https://acs.example.test/x",
      }),
    ).toEqual({ kind: "challenge", redirectUrl: "https://acs.example.test/x" });
    expect(
      mapPaySale({
        status_code: 1,
        sale_status: "failure",
        status_error_code: "301",
        status_error_details: "card declined",
      }),
    ).toEqual({ kind: "declined", code: "301", message: "card declined" });
    expect(mapPaySale({ status_code: 0, sale_status: "failed" })).toMatchObject(
      {
        kind: "declined",
      },
    );
    expect(mapPaySale({ status_code: null })).toBeNull();
  });
});

describe("isracard-map: get-transactions → verified payment", () => {
  const ref = { attemptId: ATTEMPT, saleId: null, sellerId: SELLER };

  it("a completed sale with a 20000 charge is succeeded, with the safe details", () => {
    const vp = mapTransactions([row()], ref);
    expect(vp).toMatchObject({
      state: "succeeded",
      providerRef: "SALE1655-0000AAAA-BBBBCCCC-DDDDEEEE",
      amount: { amountMinor: 187_000, currency: "ILS" },
      echoedReference: ATTEMPT,
      merchantRef: sellerFingerprint(SELLER),
      transactionId: "TRAN1655-0000AAAA-BBBBCCCC-DDDDEEEE",
      installments: 3,
      last4: "5846",
      brand: "Mastercard",
      isForeignCard: false,
      approvalCode: "1172408",
    });
    // The stored copy carries no buyer details, card mask or seller key.
    const raw = JSON.stringify(vp.rawRedacted);
    expect(raw).not.toMatch(/Test Buyer|000000018|532610|MPL/);
  });

  it("completed without a successful charge row stays pending", () => {
    expect(
      mapTransactions([row({ transaction_error_code: 33 })], ref).state,
    ).toBe("pending");
  });

  it("maps the other sale statuses", () => {
    expect(mapTransactions([row({ sale_status: "failed" })], ref).state).toBe(
      "failed",
    );
    expect(mapTransactions([row({ sale_status: "initial" })], ref).state).toBe(
      "pending",
    );
    expect(
      mapTransactions([row({ sale_status: "authorized" })], ref).state,
    ).toBe("review");
    expect(mapTransactions([row({ sale_status: "voided" })], ref).state).toBe(
      "canceled",
    );
    const partial = mapTransactions(
      [
        row({ sale_status: "partial-refund" }),
        row({
          sale_status: "partial-refund",
          transaction_action: "PartialRefund",
          transaction_price: 50_000,
          payme_transaction_id: "TRAN-R1",
        }),
      ],
      ref,
    );
    expect(partial).toMatchObject({
      state: "partially_refunded",
      refundedMinor: 50_000,
    });
  });

  it("no rows of this attempt: pending, no reference", () => {
    expect(mapTransactions([], ref)).toMatchObject({
      state: "pending",
      echoedReference: null,
      amount: null,
    });
    const other = row({
      transaction_id: "1b2c3d4e-0000-4000-8000-000000000000",
      sale_payme_id: "SALE-OTHER",
    });
    expect(mapTransactions([other], ref).state).toBe("pending");
  });

  it("the stored sale id identifies the rows when PayMe does not echo our id", () => {
    const vp = mapTransactions([row({ transaction_id: "" })], {
      ...ref,
      saleId: "SALE1655-0000AAAA-BBBBCCCC-DDDDEEEE",
    });
    expect(vp).toMatchObject({ state: "succeeded", echoedReference: ATTEMPT });
  });

  it("the sweep lists only successful charges", () => {
    const listed = listedTransactions([
      row(),
      row({ transaction_error_code: 33, payme_transaction_id: "TRAN-X" }),
      row({ transaction_action: "Refund", payme_transaction_id: "TRAN-R" }),
    ]);
    expect(listed).toEqual([
      {
        transactionId: "TRAN1655-0000AAAA-BBBBCCCC-DDDDEEEE",
        amount: { amountMinor: 187_000, currency: "ILS" },
        returnValue: ATTEMPT,
        lowProfileId: "SALE1655-0000AAAA-BBBBCCCC-DDDDEEEE",
      },
    ]);
  });
});

describe("isracard-map: callbacks", () => {
  const body = parseCallbackBody(
    new URLSearchParams({
      notify_type: "sale-complete",
      payme_sale_id: "SALE-1",
      transaction_id: ATTEMPT,
      sale_status: "completed",
      price: "187000",
      currency: "ILS",
      buyer_name: "Test Buyer",
      buyer_email: "buyer@example.test",
      buyer_phone: "0540000000",
      buyer_social_id: "000000018",
      buyer_card_mask: "532610******5846",
      buyer_key: "BUYER-SECRET",
      payme_signature: "75e99dbcb25cdfbe1c62f0b9376f4144",
    }).toString(),
  );

  it("dedupes by sale, type and status, and stores no buyer data", () => {
    expect(callbackEventKey(body)).toBe("pm:SALE-1:sale-complete:completed");
    const stored = redactCallback(body);
    expect(stored).toMatchObject({
      notify_type: "sale-complete",
      sale_status: "completed",
      payme_sale_id: "SALE-1",
    });
    expect(JSON.stringify(stored)).not.toMatch(
      /Test Buyer|@|0540000000|000000018|532610|BUYER-SECRET|75e99/,
    );
  });
});
