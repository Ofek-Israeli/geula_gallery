"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import type { Locale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";
import { orderIdForToken } from "@/server/checkout/order-view";
import { releaseReservation } from "@/server/checkout/release";
import { startPaymentForOrder } from "@/server/checkout/start";
import { ConflictError } from "@/server/domain/errors";
import { ActionFailure, publicAction } from "@/server/next/actions";
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
