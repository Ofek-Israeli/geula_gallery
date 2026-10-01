import { describe, expect, it } from "vitest";
import {
  attemptInvoiceId,
  commercialInvoiceNumber,
  isCancellationNumber,
  isOrderNumber,
  newCancellationNumber,
  newOrderNumber,
  parseInventoryNumber,
  randomCrockford,
  refundInvoiceId,
  taxDocumentMarker,
} from "@/server/domain/ids";

describe("domain ids", () => {
  it("generates canonical order and cancellation numbers", () => {
    for (let i = 0; i < 200; i++) {
      expect(isOrderNumber(newOrderNumber())).toBe(true);
      expect(isCancellationNumber(newCancellationNumber())).toBe(true);
    }
    expect(randomCrockford(10)).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  it("builds derived identifiers", () => {
    expect(commercialInvoiceNumber("GG-7K3M9Q")).toBe("CI-GG-7K3M9Q");
    expect(taxDocumentMarker("GG-7K3M9Q", "RECEIPT", 1)).toBe(
      "GG-7K3M9Q/RECEIPT/1",
    );
    expect(() => taxDocumentMarker("GG-7K3M9Q", "RECEIPT", 0)).toThrow(
      RangeError,
    );
    expect(attemptInvoiceId("GG-7K3M9Q", 2)).toBe("GG-7K3M9Q-2");
    expect(refundInvoiceId("GG-7K3M9Q", 1)).toBe("GG-7K3M9Q-R1");
    expect(parseInventoryNumber("A-2026-007")).toEqual({ year: 2026, seq: 7 });
    expect(parseInventoryNumber("A-26-7")).toBeNull();
  });
});
