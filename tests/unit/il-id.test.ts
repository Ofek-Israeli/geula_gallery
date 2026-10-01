import { describe, expect, it } from "vitest";
import {
  identityLast3,
  israeliIdCheckDigit,
  isValidIsraeliId,
  maskIdentity,
  normalizeIsraeliId,
  normalizePassport,
  parseIdOrPassport,
} from "@/lib/il-id";

describe("Israeli ID", () => {
  it("validates the check digit", () => {
    expect(isValidIsraeliId("000000018")).toBe(true);
    expect(isValidIsraeliId("123456782")).toBe(true);
    expect(isValidIsraeliId("12345678-2")).toBe(true);
    expect(isValidIsraeliId("123456789")).toBe(false);
    expect(isValidIsraeliId("000000000")).toBe(false);
    expect(isValidIsraeliId("abc")).toBe(false);
    expect(isValidIsraeliId("1234567890")).toBe(false);
  });

  it("pads short IDs to 9 digits", () => {
    expect(normalizeIsraeliId("00018")).toBe("000000018");
    expect(normalizeIsraeliId("1234")).toBeNull();
    expect(isValidIsraeliId("00018")).toBe(true);
  });

  it("computes check digits", () => {
    expect(israeliIdCheckDigit("12345678")).toBe(2);
    expect(israeliIdCheckDigit("00000001")).toBe(8);
    expect(() => israeliIdCheckDigit("123")).toThrow(RangeError);
  });
});

describe("ID or passport", () => {
  it("prefers a valid Israeli ID", () => {
    expect(parseIdOrPassport("000000018")).toEqual({
      kind: "IL_ID",
      value: "000000018",
    });
  });

  it("treats other inputs as passports", () => {
    expect(parseIdOrPassport("ab 1234567")).toEqual({
      kind: "PASSPORT",
      value: "AB1234567",
    });
    // An all-digit value failing the checksum is still a plausible foreign passport.
    expect(parseIdOrPassport("123456789")).toEqual({
      kind: "PASSPORT",
      value: "123456789",
    });
    expect(parseIdOrPassport("12")).toBeNull();
    expect(parseIdOrPassport("!!")).toBeNull();
    expect(normalizePassport("x")).toBeNull();
  });

  it("masks all but the last two characters", () => {
    expect(maskIdentity("000000018")).toBe("•••••••18");
    expect(maskIdentity("AB")).toBe("••");
    expect(identityLast3("000000018")).toBe("018");
  });
});
