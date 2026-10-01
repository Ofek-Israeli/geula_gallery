import { describe, expect, it } from "vitest";
import { postalAddressSchema } from "@/lib/validation/address";
import {
  amountMinorSchema,
  checkboxSchema,
  countrySchema,
  emailSchema,
  idOrPassportSchema,
  optionalText,
  orderNumberSchema,
  phoneSchema,
  slugSchema,
} from "@/lib/validation/common";
import {
  isCancellationNumber,
  isOrderNumber,
  isSlug,
  parseCancellationNumber,
  parseOrderNumber,
  slugify,
} from "@/lib/validation/identifiers";
import { customIssueMessage } from "@/lib/validation/messages";

describe("identifiers", () => {
  it("parses order numbers leniently into the canonical form", () => {
    expect(parseOrderNumber("gg-7k3m9q")).toBe("GG-7K3M9Q");
    expect(parseOrderNumber("7K3M 9Q")).toBe("GG-7K3M9Q");
    expect(parseOrderNumber("GG7K3M9Q")).toBe("GG-7K3M9Q");
    expect(parseOrderNumber("GG1234")).toBe("GG-GG1234");
    expect(parseOrderNumber("gg-ilo123")).toBe("GG-110123");
    expect(parseOrderNumber("GG-7K3M9U")).toBeNull();
    expect(parseOrderNumber("GG-7K3M9")).toBeNull();
    expect(isOrderNumber("GG-7K3M9Q")).toBe(true);
    expect(isOrderNumber("gg-7k3m9q")).toBe(false);
  });

  it("parses cancellation numbers", () => {
    expect(parseCancellationNumber("c-abc123")).toBe("C-ABC123");
    expect(parseCancellationNumber("ABC123")).toBe("C-ABC123");
    expect(isCancellationNumber("C-ABC123")).toBe(true);
    expect(parseCancellationNumber("C-ABU123")).toBeNull();
  });

  it("checks and builds slugs", () => {
    expect(isSlug("sunset-jaffa-2")).toBe(true);
    expect(isSlug("Sunset")).toBe(false);
    expect(isSlug("a--b")).toBe(false);
    expect(isSlug("-a")).toBe(false);
    expect(slugify("Sunset, Jaffa")).toBe("sunset-jaffa");
    expect(slugify("Café au lait")).toBe("cafe-au-lait");
    expect(slugify("שקיעה")).toBe("");
  });
});

describe("zod primitives", () => {
  it("normalises common fields", () => {
    expect(emailSchema.parse("  A@Example.COM ")).toBe("a@example.com");
    expect(emailSchema.safeParse("nope").success).toBe(false);
    expect(countrySchema.parse("us")).toBe("US");
    expect(countrySchema.safeParse("UK").success).toBe(false);
    expect(phoneSchema.parse("050-123-4567")).toBe("+972501234567");
    expect(phoneSchema.safeParse("123").success).toBe(false);
    expect(orderNumberSchema.parse("gg-7k3m9q")).toBe("GG-7K3M9Q");
    expect(slugSchema.safeParse("Bad Slug").success).toBe(false);
    expect(idOrPassportSchema.parse("000000018")).toEqual({
      kind: "IL_ID",
      value: "000000018",
    });
    expect(optionalText().parse("  ")).toBeUndefined();
    expect(optionalText().parse(" x ")).toBe("x");
    expect(checkboxSchema.parse("on")).toBe(true);
    expect(checkboxSchema.parse(undefined)).toBe(false);
  });

  it("parses admin amounts into positive minor units", () => {
    expect(amountMinorSchema.parse("45.50")).toBe(4550);
    expect(amountMinorSchema.parse(1200)).toBe(120000);
    expect(amountMinorSchema.safeParse("0").success).toBe(false);
    expect(amountMinorSchema.safeParse("1.234").success).toBe(false);
  });

  it("raises coded custom issues with bilingual messages", () => {
    const r = phoneSchema.safeParse("123");
    expect(r.success).toBe(false);
    const issue = r.error?.issues[0];
    expect(issue && customIssueMessage(issue, "en")).toBe(
      "Please enter a valid phone number",
    );
    expect(issue && customIssueMessage(issue, "he")).toBe(
      "מספר הטלפון אינו תקין",
    );
    expect(customIssueMessage({ code: "too_small" }, "en")).toBeUndefined();
  });
});

describe("postal address", () => {
  const base = {
    name: "Dana Levi",
    line1: "1 Main St",
    city: "New York",
    postalCode: "10001",
    country: "US",
    phone: "+1 212 555 0100",
  };

  it("accepts a Latin international address and normalises the phone", () => {
    const a = postalAddressSchema.parse({ ...base, line2: "" });
    expect(a.phone).toBe("+12125550100");
    expect(a.line2).toBeUndefined();
  });

  it("requires Latin script abroad, field by field", () => {
    const r = postalAddressSchema.safeParse({ ...base, city: "ניו יורק" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual(["city"]);
    expect(
      r.error?.issues[0] && customIssueMessage(r.error.issues[0], "en"),
    ).toMatch(/Latin/);
  });

  it("allows Hebrew for Israeli destinations", () => {
    const r = postalAddressSchema.safeParse({
      ...base,
      name: "דנה לוי",
      line1: "הרצל 1",
      city: "תל אביב",
      country: "IL",
      phone: "050-123-4567",
    });
    expect(r.success).toBe(true);
  });
});
