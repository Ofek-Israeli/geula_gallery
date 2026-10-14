import { describe, expect, it } from "vitest";
import {
  checkHolder,
  type HolderInput,
  tokenizeFailure,
} from "@/app/[locale]/(checkout)/checkout/pay/[attemptId]/holder";

/** The card holder's details on the Isracard pay page (`holder.ts`). */
const valid: HolderInput = {
  firstName: "Test",
  lastName: "Buyer",
  socialId: "",
  email: "buyer@example.test",
  phone: "050-123-4567",
};

describe("pay page: the card holder's details", () => {
  it("names every missing detail, in page order; the ID number is optional", () => {
    expect(
      checkHolder({
        firstName: " ",
        lastName: "",
        socialId: "",
        email: "",
        phone: "",
      }).problems,
    ).toEqual(["firstName", "lastName", "email", "phone"]);
    expect(checkHolder(valid)).toEqual({ problems: [], socialId: "" });
  });

  it("an ID number must pass the Israeli check digit; it is sent as 9 digits", () => {
    expect(checkHolder({ ...valid, socialId: "123456789" }).problems).toEqual([
      "socialId",
    ]);
    expect(checkHolder({ ...valid, socialId: "008-336-174" })).toEqual({
      problems: [],
      socialId: "008336174",
    });
    expect(checkHolder({ ...valid, socialId: "8336174" }).socialId).toBe(
      "008336174",
    );
    expect(checkHolder({ ...valid, socialId: "12ab" }).problems).toEqual([
      "socialId",
    ]);
  });

  it("checks the email and the phone (Israeli or international)", () => {
    for (const email of ["a@b", "no-at.example.com", "a b@example.com"]) {
      expect(checkHolder({ ...valid, email }).problems).toEqual(["email"]);
    }
    for (const phone of ["03-000-0000", "+44 20 7946 0958", "0501234567"]) {
      expect(checkHolder({ ...valid, phone }).problems).toEqual([]);
    }
    for (const phone of ["123", "+972 12", "phone"]) {
      expect(checkHolder({ ...valid, phone }).problems).toEqual(["phone"]);
    }
  });
});

describe("pay page: a refused tokenization", () => {
  it("maps PayMe's field errors to ours (unknown names count as the card)", () => {
    expect(
      tokenizeFailure({
        validationError: true,
        errors: {
          payerEmail: "Mandatory field",
          cardExpiration: "Invalid",
          somethingNew: "?",
          cardNumber: "Invalid",
        },
        type: "tokenize-error",
      }),
    ).toEqual({
      kind: "fields",
      fields: ["email", "cardExpiration", "cardNumber"],
    });
  });

  it("a spent or expired session needs new fields; anything else is the card", () => {
    expect(
      tokenizeFailure({
        error: "Bad session",
        message: "Session expired or deleted",
        statusCode: 400,
        type: "tokenize-error",
      }),
    ).toEqual({ kind: "session" });
    expect(tokenizeFailure(new Error("network"))).toEqual({ kind: "card" });
    expect(tokenizeFailure(undefined)).toEqual({ kind: "card" });
  });
});
