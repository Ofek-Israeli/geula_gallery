import { describe, expect, it } from "vitest";
import {
  checkCardNumber,
  checkCvc,
  checkExpiry,
  formatCardNumber,
  formatExpiry,
  isracardValid,
  luhnValid,
  parseExpiry,
} from "@/lib/card";

/** Our own payment page's card checks (`src/lib/card.ts`); the numbers are published test cards. */
describe("card number", () => {
  it("international cards: Luhn check digit and the brand from the prefix", () => {
    expect(checkCardNumber("4111 1111 1111 1111")).toEqual({
      valid: true,
      brand: "visa",
    });
    expect(checkCardNumber("5555-5555-5555-4444").brand).toBe("mastercard");
    expect(checkCardNumber("2223003122003222").brand).toBe("mastercard");
    expect(checkCardNumber("378282246310005").brand).toBe("amex");
    expect(checkCardNumber("30569309025904").brand).toBe("diners");
    expect(checkCardNumber("5326105300985846")).toEqual({
      valid: true,
      brand: "mastercard",
    });
    expect(checkCardNumber("4111111111111112").valid).toBe(false);
    expect(checkCardNumber("411111111111").valid).toBe(false);
    expect(checkCardNumber("4111 1111 1111 111a").valid).toBe(false);
    expect(luhnValid("")).toBe(false);
  });

  it("Isracard's local 8–9 digit cards use the mod-11 check", () => {
    for (const n of ["123456789", "456789014", "12345679", "76543218"]) {
      expect(isracardValid(n)).toBe(true);
      expect(checkCardNumber(n)).toEqual({ valid: true, brand: "isracard" });
    }
    expect(checkCardNumber("123456788")).toEqual({ valid: false, brand: null });
    expect(isracardValid("1234567")).toBe(false);
  });

  it("is shown in groups of four (American Express 4-6-5, short Isracard numbers as typed)", () => {
    expect(formatCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
    expect(formatCardNumber("123456789")).toBe("123456789");
    expect(formatCardNumber("4111 1111 11")).toBe("4111 1111 11");
    expect(formatCardNumber("4111 11")).toBe("411111"); // up to 9 digits: as typed
  });
});

describe("expiry and CVV", () => {
  const now = new Date(2026, 9, 14); // 14 October 2026

  it("reads MM/YY, MMYY and spaced forms", () => {
    expect(parseExpiry("12/30")).toEqual({ month: 12, year: 2030 });
    expect(parseExpiry("1230")).toEqual({ month: 12, year: 2030 });
    expect(parseExpiry(" 3 / 27 ")).toEqual({ month: 3, year: 2027 });
    expect(parseExpiry("13/30")).toBeNull();
    expect(parseExpiry("00/30")).toBeNull();
    expect(parseExpiry("12/2030")).toBeNull();
    expect(formatExpiry("330")).toBe("03/30");
  });

  it("a card is valid through its expiry month, and not decades ahead", () => {
    expect(checkExpiry("10/26", now)).toBe("ok");
    expect(checkExpiry("09/26", now)).toBe("expired");
    expect(checkExpiry("10/46", now)).toBe("ok"); // 20 years ahead
    expect(checkExpiry("11/46", now)).toBe("invalid");
    expect(checkExpiry("1/2", now)).toBe("invalid");
  });

  it("CVV: 3 digits, 4 for American Express", () => {
    expect(checkCvc("123", "visa")).toBe(true);
    expect(checkCvc("123", null)).toBe(true);
    expect(checkCvc("1234", "visa")).toBe(false);
    expect(checkCvc("1234", "amex")).toBe(true);
    expect(checkCvc("123", "amex")).toBe(false);
    expect(checkCvc("12a", "isracard")).toBe(false);
  });
});
