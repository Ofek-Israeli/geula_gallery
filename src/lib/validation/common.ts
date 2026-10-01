/**
 * Shared zod primitives for Server Action inputs (spec §2.2: every action zod-parses its input;
 * §6.4: locale-aware messages). Domain-specific checks raise custom issues whose text comes from
 * `./messages`. Workstreams compose these in their own schemas.
 */
import { z } from "zod";
import { isCountryCode } from "../countries";
import { parseIdOrPassport } from "../il-id";
import { LOCALE_VALUES } from "../locale";
import { CURRENCIES, fromDecimal } from "../money";
import { normalizePhone } from "../phone";
import { parseOrderNumber, SLUG_RE } from "./identifiers";
import { issueParams } from "./messages";

/** Trims; empty strings become undefined (HTML forms send "" for blank optional fields). */
export const optionalText = (max = 500) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const requiredText = (max = 500) => z.string().trim().min(1).max(max);

export const localeSchema = z.enum(LOCALE_VALUES);
export const currencySchema = z.enum(CURRENCIES);

export const personNameSchema = requiredText(120);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountryCode, issueParams("invalid_country"));

/** Accepts local Israeli or international input; outputs E.164. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const e164 = normalizePhone(v);
    if (!e164) {
      ctx.addIssue({ code: "custom", ...issueParams("invalid_phone") });
      return z.NEVER;
    }
    return e164;
  });

export const slugSchema = z
  .string()
  .trim()
  .max(120)
  .refine((v) => SLUG_RE.test(v), issueParams("invalid_slug"));

export const orderNumberSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = parseOrderNumber(v);
    if (!n) {
      ctx.addIssue({ code: "custom", ...issueParams("invalid_order_number") });
      return z.NEVER;
    }
    return n;
  });

/** ID (checksum-validated) or passport; outputs `{ kind, value }`. */
export const idOrPassportSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const doc = parseIdOrPassport(v);
    if (!doc) {
      ctx.addIssue({
        code: "custom",
        ...issueParams("invalid_id_or_passport"),
      });
      return z.NEVER;
    }
    return doc;
  });

/** A decimal amount typed by the admin (`"1200"`, `"45.50"`) → integer minor units (> 0). */
export const amountMinorSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return fromDecimal(v);
    } catch {
      ctx.addIssue({ code: "custom", ...issueParams("invalid_amount") });
      return z.NEVER;
    }
  })
  .pipe(z.number().int().positive());

/** Checkbox: `"on"` / `"true"` / `true` → true; absent → false. */
export const checkboxSchema = z.preprocess(
  (v) => v === "on" || v === "true" || v === true || v === "1",
  z.boolean(),
);

export const uuidSchema = z.uuid();
