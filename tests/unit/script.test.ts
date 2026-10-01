import { describe, expect, it } from "vitest";
import {
  hasHebrew,
  isLatinText,
  nonLatinFields,
  textDirection,
} from "@/lib/script";

describe("script", () => {
  it("accepts Latin letters, digits, punctuation and spaces", () => {
    expect(isLatinText("12 Main St., Apt. 4")).toBe(true);
    expect(isLatinText("Café Straße 5-7")).toBe(true);
    expect(isLatinText("O'Brien (c/o)")).toBe(true);
  });

  it("rejects Hebrew and other scripts", () => {
    expect(isLatinText("רחוב הרצל 1")).toBe(false);
    expect(isLatinText("Main St 1 תל אביב")).toBe(false);
    expect(isLatinText("Москва")).toBe(false);
    expect(isLatinText("東京")).toBe(false);
    expect(isLatinText("")).toBe(false);
    expect(hasHebrew("abc א")).toBe(true);
  });

  it("checks address fields only for international destinations", () => {
    const fields = {
      line1: "1 Main St",
      city: "תל אביב",
      region: "",
      line2: undefined,
    };
    expect(nonLatinFields(fields, "US")).toEqual(["city"]);
    expect(nonLatinFields(fields, "IL")).toEqual([]);
  });

  it("guesses direction from the first strong character", () => {
    expect(textDirection("שלום hello")).toBe("rtl");
    expect(textDirection("123 hello שלום")).toBe("ltr");
    expect(textDirection("123", "rtl")).toBe("rtl");
    expect(textDirection("مرحبا")).toBe("rtl");
  });
});
