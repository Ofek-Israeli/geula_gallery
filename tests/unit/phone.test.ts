import { describe, expect, it } from "vitest";
import {
  formatPhone,
  isE164,
  isIsraeliMobile,
  isValidPhone,
  normalizePhone,
  telHref,
  whatsappHref,
} from "@/lib/phone";

describe("phone", () => {
  it("normalises Israeli national numbers to E.164", () => {
    expect(normalizePhone("050-123-4567")).toBe("+972501234567");
    expect(normalizePhone("03-000-0000")).toBe("+97230000000");
    expect(normalizePhone("(03) 000 0000")).toBe("+97230000000");
    expect(normalizePhone("072-123-4567")).toBe("+972721234567");
  });

  it("accepts international input with + or 00", () => {
    expect(normalizePhone("+972 50 123 4567")).toBe("+972501234567");
    expect(normalizePhone("+972-3-000-0000")).toBe("+97230000000");
    expect(normalizePhone("+972 050 123 4567")).toBe("+972501234567");
    expect(normalizePhone("00972501234567")).toBe("+972501234567");
    expect(normalizePhone("+1 212 555 0100")).toBe("+12125550100");
    expect(normalizePhone("+44 20 7946 0000")).toBe("+442079460000");
  });

  it("rejects malformed numbers", () => {
    for (const bad of [
      "",
      "12345",
      "050-123",
      "+972 1234",
      "+0123456789",
      "phone",
    ]) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
    // A national number without a country prefix is only understood for IL.
    expect(normalizePhone("0501234567", "US")).toBeNull();
    expect(isValidPhone("050-123-4567")).toBe(true);
  });

  it("formats for display and links", () => {
    expect(formatPhone("+972501234567", "he")).toBe("050-123-4567");
    expect(formatPhone("+972501234567", "en")).toBe("+972 50-123-4567");
    expect(formatPhone("+97230000000", "he")).toBe("03-000-0000");
    expect(formatPhone("+97230000000", "en")).toBe("+972 3-000-0000");
    expect(formatPhone("+12125550100", "en")).toBe("+12125550100");
    expect(isE164("+12125550100")).toBe(true);
    expect(isIsraeliMobile("+972501234567")).toBe(true);
    expect(isIsraeliMobile("+97230000000")).toBe(false);
    expect(telHref("+97230000000")).toBe("tel:+97230000000");
    expect(whatsappHref("+972501234567")).toBe("https://wa.me/972501234567");
  });
});
