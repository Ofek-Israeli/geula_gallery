"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import type { Locale } from "@/lib/locale";
import { normalizePhone } from "@/lib/phone";
import { localePath, paths } from "@/lib/routes";
import { nonLatinFields } from "@/lib/script";
import {
  checkboxSchema,
  countrySchema,
  optionalText,
} from "@/lib/validation/common";
import { issueParams } from "@/lib/validation/messages";
import {
  completeLinkOrderDetails,
  type LinkDetailsResult,
} from "@/server/checkout/link-details";
import { orderIdForToken } from "@/server/checkout/order-view";
import { releaseReservation } from "@/server/checkout/release";
import { startPaymentForOrder } from "@/server/checkout/start";
import { ConflictError } from "@/server/domain/errors";
import {
  ActionFailure,
  type ActionState,
  publicAction,
} from "@/server/next/actions";
import { applyEffects } from "@/server/next/effects";
import { PROVIDER_IDS } from "@/server/payments/types";

/**
 * Order page actions (spec §5.1 step 4): "Pay" (a new attempt with the current quote version) and
 * "Release my hold". Both authorize with the order's `?k=` token, are rate limited per IP, and are
 * refused while a payment is being confirmed. Plain POST forms: the result is a redirect back to
 * the order page (with `err=` on refusal) or to the provider.
 */
const base = z.object({
  number: z.string().regex(/^GG-[0-9A-Z]{6}$/),
  k: z.string().min(1).max(64),
});

function back(locale: Locale, number: string, k: string, query = ""): string {
  const path = localePath(locale, paths.order(number, k));
  return query ? `${path}&${query}` : path;
}

const runPay = publicAction(
  base.extend({ providerId: z.enum(PROVIDER_IDS) }),
  async (input, meta) => {
    const order = await orderIdForToken(input.number, input.k);
    if (!order) throw new ActionFailure("NOT_FOUND");
    const { result, effects } = await startPaymentForOrder({
      orderId: order.id,
      providerId: input.providerId,
      locale: meta.locale,
      ipHash: meta.ipHash,
    });
    applyEffects(effects);
    if (result.kind === "redirect") redirect(result.url);
    const code =
      result.kind === "refused"
        ? result.code
        : result.kind === "provider_error"
          ? "provider_error"
          : "generic";
    redirect(back(meta.locale, input.number, input.k, `err=${code}`));
  },
  {
    name: "orders.pay",
    honeypot: false,
    minFormAge: false,
    limits: [{ name: "checkoutIp", by: "ip" }],
  },
);

const runRelease = publicAction(
  base,
  async (input, meta) => {
    const order = await orderIdForToken(input.number, input.k);
    if (!order) throw new ActionFailure("NOT_FOUND");
    try {
      const { effects } = await releaseReservation({
        orderId: order.id,
        actor: `buyer:${input.number}`,
        reason: "RELEASED",
      });
      applyEffects(effects);
    } catch (error) {
      if (error instanceof ConflictError) {
        redirect(back(meta.locale, input.number, input.k, "err=in_flight"));
      }
      throw error;
    }
    redirect(back(meta.locale, input.number, input.k, "released=1"));
  },
  {
    name: "orders.release",
    honeypot: false,
    minFormAge: false,
    limits: [{ name: "checkoutIp", by: "ip" }],
  },
);

function fallback(formData: FormData, code: string): never {
  const locale = formData.get("locale") === "en" ? "en" : "he";
  const number = String(formData.get("number") ?? "");
  const k = String(formData.get("k") ?? "");
  if (/^GG-[0-9A-Z]{6}$/.test(number) && k) {
    redirect(back(locale, number, k, `err=${code}`));
  }
  redirect(localePath(locale, paths.works()));
}

export async function payOrderAction(formData: FormData): Promise<void> {
  const r = await runPay(null, formData);
  if (r && !r.ok) {
    fallback(
      formData,
      r.error.code === "RATE_LIMITED" ? "rate_limited" : "generic",
    );
  }
}

export async function releaseHoldAction(formData: FormData): Promise<void> {
  const r = await runRelease(null, formData);
  if (r && !r.ok) {
    fallback(
      formData,
      r.error.code === "RATE_LIMITED" ? "rate_limited" : "generic",
    );
  }
}

// ---------------------------------------------------------------- link order details

/**
 * "Complete your order" on a link order (spec §5.1 step 4, §5.8): the delivery address (Latin
 * abroad), the delivery method when the painter did not lock the shipping, the consents (terms,
 * 18+, DAP abroad, receipt by email). A method change requotes the order. Authorized by the `?k=`
 * token like "Pay"; the result redirects back to the order page.
 */
const has = (v: string | undefined) => v !== undefined && v !== "";

const detailsSchema = base
  .extend({
    country: countrySchema,
    method: z
      .enum(["CARRIER_TABLE", "LOCAL_PICKUP", "ARTIST_DELIVERY", "QUOTED"])
      .optional(),
    recipient: optionalText(120),
    phone: optionalText(40),
    line1: optionalText(200),
    line2: optionalText(200),
    city: optionalText(120),
    region: optionalText(120),
    postalCode: optionalText(20),
    companyName: optionalText(200),
    vatId: optionalText(40),
    needsAddress: checkboxSchema,
    terms: checkboxSchema.refine((v) => v),
    age: checkboxSchema.refine((v) => v),
    dap: checkboxSchema,
    receiptEmail: checkboxSchema,
  })
  .superRefine((v, ctx) => {
    const pickup = v.method === "LOCAL_PICKUP" || !v.needsAddress;
    if (!pickup) {
      for (const field of ["recipient", "line1", "city"] as const) {
        if (!has(v[field])) {
          ctx.addIssue({ code: "custom", path: [field], message: "required" });
        }
      }
      if (v.country !== "IL" && !has(v.postalCode)) {
        ctx.addIssue({
          code: "custom",
          path: ["postalCode"],
          message: "required",
        });
      }
      const fields = {
        recipient: v.recipient,
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
    if (has(v.phone) && !normalizePhone(v.phone ?? "")) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        ...issueParams("invalid_phone"),
      });
    }
    if (v.country !== "IL" && !v.dap) {
      ctx.addIssue({ code: "custom", path: ["dap"], message: "required" });
    }
  });

export type LinkDetailsActionData = Extract<
  LinkDetailsResult,
  { kind: "refused" }
>;

const runDetails = publicAction(
  detailsSchema,
  async (input, meta) => {
    const order = await orderIdForToken(input.number, input.k);
    if (!order) throw new ActionFailure("NOT_FOUND");
    const pickup = input.method === "LOCAL_PICKUP" || !input.needsAddress;
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const { result, effects } = await completeLinkOrderDetails({
      orderId: order.id,
      ...(input.method ? { method: input.method } : {}),
      shipTo: pickup
        ? null
        : {
            name: input.recipient ?? "",
            line1: input.line1 ?? "",
            ...(input.line2 ? { line2: input.line2 } : {}),
            city: input.city ?? "",
            ...(input.region ? { region: input.region } : {}),
            ...(input.postalCode ? { postalCode: input.postalCode } : {}),
            country: input.country,
            phone: phone ?? "",
          },
      buyer: {
        ...(phone ? { phone } : {}),
        ...(input.companyName ? { companyName: input.companyName } : {}),
        ...(input.vatId ? { vatId: input.vatId } : {}),
      },
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
      actor: `buyer:${input.number}`,
      ipHash: meta.ipHash,
    });
    applyEffects(effects);
    if (result.kind === "saved") {
      redirect(
        back(
          meta.locale,
          input.number,
          input.k,
          result.totalChanged ? "details=requoted" : "details=saved",
        ),
      );
    }
    return { result, effects };
  },
  {
    name: "orders.link_details",
    honeypot: false,
    minFormAge: false,
    limits: [{ name: "checkoutIp", by: "ip" }],
  },
);

export async function saveLinkDetailsAction(
  prev: ActionState<LinkDetailsActionData>,
  formData: FormData,
): Promise<ActionState<LinkDetailsActionData>> {
  return runDetails(prev, formData) as Promise<
    ActionState<LinkDetailsActionData>
  >;
}
