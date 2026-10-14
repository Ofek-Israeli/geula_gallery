import { z } from "zod";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import { CHECKOUT_METHODS } from "@/lib/checkout-steps";
import type { Locale } from "@/lib/locale";
import { nonLatinFields } from "@/lib/script";
import {
  checkboxSchema,
  countrySchema,
  currencySchema,
  emailSchema,
  optionalText,
  personNameSchema,
  phoneSchema,
} from "@/lib/validation/common";
import {
  DESTINATION_LIMITS,
  destinationIssues,
} from "@/lib/validation/destination";
import { issueParams } from "@/lib/validation/messages";
import type { StartCheckoutResult } from "@/server/checkout/types";
import { PROVIDER_IDS } from "@/server/payments/types";

/**
 * The checkout form's fields, shared by "Buy now" (`/checkout/[slug]`, adds `slug`) and the cart
 * checkout (`/checkout`, adds `item` fields). The client never sends prices that matter: the totals
 * and item prices are only compared with the server re-quote. City and postal code come from the
 * destination step (hidden fields; a pickup posts neither).
 */
const required = (v: string | undefined) => v !== undefined && v !== "";

export const checkoutFields = {
  country: countrySchema,
  method: z.enum(CHECKOUT_METHODS),
  currency: currencySchema,
  /** "ROLLED" when the buyer chose to have the works rolled in a tube (step 2). */
  packing: z.enum(["ROLLED"]).optional(),
  providerId: z.enum(PROVIDER_IDS),
  expectedTotalMinor: z.coerce.number().int().nonnegative(),
  clientRequestId: z.uuid(),
  name: personNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  companyName: optionalText(200),
  vatId: optionalText(40),
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(DESTINATION_LIMITS.city),
  region: optionalText(120),
  postalCode: optionalText(DESTINATION_LIMITS.postalCode),
  terms: checkboxSchema.refine((v) => v),
  dap: checkboxSchema,
  receiptEmail: checkboxSchema,
};

type Fields = z.output<z.ZodObject<typeof checkoutFields>>;

/**
 * Street address unless pickup; city and postal code by the destination rules (a postal code
 * abroad unless the destination has none); Latin script abroad; the DAP consent abroad.
 */
export function refineCheckout(v: Fields, ctx: z.RefinementCtx): void {
  if (v.method !== "LOCAL_PICKUP") {
    if (!required(v.line1)) {
      ctx.addIssue({ code: "custom", path: ["line1"], message: "required" });
    }
    const destination = destinationIssues({
      country: v.country,
      city: v.city,
      postalCode: v.postalCode,
    });
    for (const field of ["city", "postalCode"] as const) {
      const issue = destination[field];
      if (issue === "required") {
        ctx.addIssue({ code: "custom", path: [field], message: "required" });
      } else if (issue === "latin_only") {
        ctx.addIssue({
          code: "custom",
          path: [field],
          ...issueParams("latin_only"),
        });
      }
      // too_long: optionalText's own max check reports it.
    }
    const fields = {
      name: v.name,
      line1: v.line1,
      line2: v.line2,
      region: v.region,
    };
    for (const field of nonLatinFields(fields, v.country)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        ...issueParams("latin_only"),
      });
    }
  }
  if (v.country !== "IL" && !v.dap) {
    ctx.addIssue({ code: "custom", path: ["dap"], message: "required" });
  }
}

/** Cart lines as posted: repeated `item` fields `"<artwork uuid>:<price minor>"` (1–20). */
export const cartItemsField = z.preprocess(
  (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
  z
    .array(
      z
        .string()
        .regex(/^[0-9a-f-]{36}:\d{1,12}$/)
        .transform((s) => {
          const [artworkId, price] = s.split(":") as [string, string];
          return { artworkId, expectedPriceMinor: Number(price) };
        }),
    )
    .min(1)
    .max(20)
    .refine(
      (items) => new Set(items.map((i) => i.artworkId)).size === items.length,
    ),
);

/** Everything but the works, mapped from the parsed form. */
export function startBase(
  input: Fields,
  meta: { locale: Locale; ipHash: string | null },
) {
  return {
    locale: meta.locale,
    country: input.country,
    method: input.method,
    currency: input.currency,
    ...(input.packing ? { packing: input.packing } : {}),
    providerId: input.providerId,
    buyer: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      ...(input.companyName ? { companyName: input.companyName } : {}),
      ...(input.vatId ? { vatId: input.vatId } : {}),
    },
    shipTo:
      input.method === "LOCAL_PICKUP"
        ? null
        : {
            name: input.name,
            line1: input.line1 ?? "",
            ...(input.line2 ? { line2: input.line2 } : {}),
            city: input.city ?? "",
            ...(input.region ? { region: input.region } : {}),
            ...(input.postalCode ? { postalCode: input.postalCode } : {}),
            country: input.country,
            phone: input.phone,
          },
    expectedTotalMinor: input.expectedTotalMinor,
    clientRequestId: input.clientRequestId,
    consents: {
      termsVersion: LEGAL_VERSIONS.terms,
      returnsVersion: LEGAL_VERSIONS.returns,
      privacyVersion: LEGAL_VERSIONS.privacy,
      ...(input.country !== "IL"
        ? { dutiesNoticeVersion: LEGAL_VERSIONS.dutiesNotice }
        : {}),
      receiptEmailConsent: input.receiptEmail,
    },
    ipHash: meta.ipHash,
  };
}

/**
 * What the form gets back after a submit that did not redirect. `redirect` and `provider_error`
 * never reach it: both go to a page (the provider, or the order page with the error). `navigate`
 * is our own pay page, which the form opens with a full page load (it has its own CSP).
 */
export type CheckoutActionData =
  | Exclude<
      StartCheckoutResult,
      { kind: "redirect" } | { kind: "provider_error" }
    >
  | { kind: "navigate"; url: string };
