import { isValidIsraeliId, normalizeIsraeliId } from "@/lib/il-id";
import { isValidPhone } from "@/lib/phone";

/**
 * The card holder's details on the Isracard pay page, checked in the browser before the hosted
 * fields tokenize them (PayMe would otherwise refuse with "Mandatory field"). Nothing here sees
 * card data: card number, expiry and CVV stay inside Isracard's fields.
 */
export const HOLDER_FIELDS = [
  "firstName",
  "lastName",
  "socialId",
  "email",
  "phone",
] as const;
export type HolderField = (typeof HOLDER_FIELDS)[number];
export type HolderInput = Record<HolderField, string>;

export const CARD_FIELDS = ["cardNumber", "cardExpiration", "cvc"] as const;
export type CardField = (typeof CARD_FIELDS)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Problems in page order, and the ID number as 9 digits ("" when not given). The ID is optional
 * (foreign cards have none); when given it must pass the Israeli check digit.
 */
export function checkHolder(input: HolderInput): {
  problems: HolderField[];
  socialId: string;
} {
  const v = (f: HolderField) => input[f].trim();
  const socialId = v("socialId") ? normalizeIsraeliId(v("socialId")) : "";
  const bad: Record<HolderField, boolean> = {
    firstName: !v("firstName"),
    lastName: !v("lastName"),
    socialId: v("socialId") !== "" && !isValidIsraeliId(v("socialId")),
    email: v("email").length > 254 || !EMAIL_RE.test(v("email")),
    phone: !isValidPhone(v("phone")),
  };
  return {
    problems: HOLDER_FIELDS.filter((f) => bad[f]),
    socialId: socialId ?? "",
  };
}

/** PayMe's tokenize error keys (`errors: { payerEmail: "Mandatory field" }`) → our fields. */
const PAYME_KEYS: Record<string, HolderField | CardField> = {
  payerFirstName: "firstName",
  payerLastName: "lastName",
  payerSocialId: "socialId",
  payerEmail: "email",
  payerPhone: "phone",
  cardNumber: "cardNumber",
  cardExpiration: "cardExpiration",
  cvc: "cvc",
};

export type TokenizeFailure =
  /** PayMe named fields to fix (unknown names count as the card). */
  | { kind: "fields"; fields: (HolderField | CardField)[] }
  /** The fields' session is spent (already tokenized) or expired: create them again. */
  | { kind: "session" }
  | { kind: "card" };

/** Reads a rejected `tokenize()` (docs.payme.io "Hosted Fields JSAPI", read 2026-10-14). */
export function tokenizeFailure(error: unknown): TokenizeFailure {
  const e = (error ?? {}) as {
    validationError?: unknown;
    errors?: unknown;
    error?: unknown;
    statusCode?: unknown;
  };
  if (e.validationError && e.errors && typeof e.errors === "object") {
    const fields = Object.keys(e.errors).map(
      (k) => PAYME_KEYS[k] ?? "cardNumber",
    );
    return { kind: "fields", fields: [...new Set(fields)] };
  }
  if (e.error === "Bad session" || e.statusCode === 400) {
    return { kind: "session" };
  }
  return { kind: "card" };
}
