/**
 * Localized messages for the domain-specific checks in `src/lib/validation/*` (spec §6.4). The
 * schemas raise custom issues with `params: { code }`; `customIssueMessage()` turns that code into
 * text for the action's locale (`src/server/next/actions.ts` consults it before zod's own locale
 * map). Built-in zod checks keep zod's `he` / `en` locale messages.
 */
import type { Locale } from "../locale";

export const VALIDATION_MESSAGES = {
  latin_only: {
    he: "יש להזין באותיות לטיניות (אנגלית) למשלוח לחו״ל",
    en: "Please use Latin (English) characters for international shipping",
  },
  invalid_phone: {
    he: "מספר הטלפון אינו תקין",
    en: "Please enter a valid phone number",
  },
  invalid_country: {
    he: "יש לבחור מדינה",
    en: "Please choose a country",
  },
  invalid_il_id: {
    he: "מספר תעודת הזהות אינו תקין",
    en: "Please enter a valid Israeli ID number",
  },
  invalid_id_or_passport: {
    he: "יש להזין מספר תעודת זהות או דרכון תקין",
    en: "Please enter a valid ID or passport number",
  },
  invalid_order_number: {
    he: "מספר ההזמנה אינו תקין (לדוגמה GG-7K3M9Q)",
    en: "Please enter a valid order number (e.g. GG-7K3M9Q)",
  },
  invalid_slug: {
    he: "כתובת לא תקינה: אותיות לטיניות קטנות, ספרות ומקפים בלבד",
    en: "Use lower-case Latin letters, digits and single hyphens only",
  },
  invalid_amount: {
    he: "סכום לא תקין (עד שתי ספרות אחרי הנקודה)",
    en: "Invalid amount (at most 2 decimal places)",
  },
  id_or_order_required: {
    he: "יש להזין מספר תעודת זהות/דרכון או מספר הזמנה",
    en: "Enter your ID/passport number or your order number",
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type ValidationCode = keyof typeof VALIDATION_MESSAGES;

export function isValidationCode(value: unknown): value is ValidationCode {
  return typeof value === "string" && value in VALIDATION_MESSAGES;
}

/** `{ params: { code } }` for `.refine()` / `ctx.addIssue()`. */
export function issueParams(code: ValidationCode): {
  params: { code: ValidationCode };
} {
  return { params: { code } };
}

/** The localized text for a custom issue raised by these schemas, or undefined. */
export function customIssueMessage(
  issue: { code?: string; params?: unknown },
  locale: Locale,
): string | undefined {
  if (issue.code !== "custom") return undefined;
  const code = (issue.params as { code?: unknown } | undefined)?.code;
  return isValidationCode(code) ? VALIDATION_MESSAGES[code][locale] : undefined;
}
