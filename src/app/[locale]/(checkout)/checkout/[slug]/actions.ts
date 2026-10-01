"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import { nonLatinFields } from "@/lib/script";
import {
  checkboxSchema,
  countrySchema,
  currencySchema,
  emailSchema,
  optionalText,
  personNameSchema,
  phoneSchema,
  slugSchema,
} from "@/lib/validation/common";
import { issueParams } from "@/lib/validation/messages";
import { startCheckout } from "@/server/checkout/start";
import type { StartCheckoutResult } from "@/server/checkout/types";
import { type ActionState, publicAction } from "@/server/next/actions";
import { applyEffects } from "@/server/next/effects";
import { PROVIDER_IDS } from "@/server/payments/types";

/**
 * `startCheckoutAction` (spec §5.1 step 3): honeypot → form age → rate limits (10 / 10 min per IP,
 * 5 / h per email) → zod with locale-aware messages → `startCheckout` → redirect to the provider.
 * The client never sends prices: `expectedTotalMinor` is only compared with the server re-quote.
 */
const required = (v: string | undefined) => v !== undefined && v !== "";

const schema = z
  .object({
    slug: slugSchema,
    country: countrySchema,
    method: z.enum(["CARRIER_TABLE", "LOCAL_PICKUP", "ARTIST_DELIVERY"]),
    currency: currencySchema,
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
    city: optionalText(120),
    region: optionalText(120),
    postalCode: optionalText(20),
    terms: checkboxSchema.refine((v) => v),
    age: checkboxSchema.refine((v) => v),
    dap: checkboxSchema,
    receiptEmail: checkboxSchema,
  })
  .superRefine((v, ctx) => {
    if (v.method !== "LOCAL_PICKUP") {
      for (const field of ["line1", "city"] as const) {
        if (!required(v[field])) {
          ctx.addIssue({ code: "custom", path: [field], message: "required" });
        }
      }
      if (v.country !== "IL" && !required(v.postalCode)) {
        ctx.addIssue({
          code: "custom",
          path: ["postalCode"],
          message: "required",
        });
      }
      const fields = {
        name: v.name,
        line1: v.line1,
        line2: v.line2,
        city: v.city,
        region: v.region,
        postalCode: v.postalCode,
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
  });

export type CheckoutActionData = Exclude<
  StartCheckoutResult,
  { kind: "redirect" }
>;

const run = publicAction(
  schema,
  async (input, meta) => {
    const { result, effects } = await startCheckout({
      slug: input.slug,
      locale: meta.locale,
      country: input.country,
      method: input.method,
      currency: input.currency,
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
        ageConfirmed: true,
        ...(input.country !== "IL"
          ? { dutiesNoticeVersion: LEGAL_VERSIONS.dutiesNotice }
          : {}),
        receiptEmailConsent: input.receiptEmail,
      },
      ipHash: meta.ipHash,
    });
    if (result.kind === "redirect") {
      applyEffects(effects);
      redirect(result.url);
    }
    return { result: result as CheckoutActionData, effects };
  },
  {
    name: "checkout.start",
    limits: [
      { name: "checkoutIp", by: "ip" },
      { name: "checkoutEmail", by: (i) => i.email },
    ],
  },
);

export async function startCheckoutAction(
  prev: ActionState<CheckoutActionData>,
  formData: FormData,
): Promise<ActionState<CheckoutActionData>> {
  return run(prev, formData);
}
