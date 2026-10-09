"use server";

import { z } from "zod";
import type { Locale } from "@/lib/locale";
import { isValidationCode } from "@/lib/validation/messages";
import {
  cancellationNoticeSchema,
  displayNotice,
  type NoticeDisplay,
  openReview,
  type ReviewItem,
  sealReview,
} from "@/server/cancellations/notice";
import {
  type AckSnapshot,
  previewCancellableItems,
  recordCancellationNotice,
} from "@/server/cancellations/service";
import { withEffects } from "@/server/domain/effects";
import { publicAction } from "@/server/next/actions";

/**
 * The public cancellation flow (spec §5.7 steps 3–4) as one POST Server Action, so it works
 * without JavaScript (React re-renders the page with the returned state): `review` validates the
 * form and returns a sealed payload plus the masked review; `confirm` opens the payload and
 * **always** stores the notice; `edit` goes back to the form (the ID number is not echoed back).
 * When the order number and the name or email match an order with several works, the review step
 * lists them as checkboxes (all ticked): the buyer may cancel only some. Nothing is ever put in the
 * URL. Limits: honeypot, minimum form age, 20 per hour per IP.
 */
export type CancelFormValues = Partial<
  Record<
    | "fullName"
    | "orderNumber"
    | "email"
    | "phone"
    | "reason"
    | "message"
    | "shippedTo"
    | "eligibleGroup",
    string
  >
>;

export type CancelFlowState =
  | {
      step: "form";
      values: CancelFormValues;
      /** Field → message code (`cancel.form.errors.<code>` or a shared validation code). */
      errors?: Record<string, string>;
      banner?: "expired" | "idAgain";
    }
  | {
      step: "review";
      token: string;
      display: NoticeDisplay;
      /** The order's works to choose from (2 or more), else empty. */
      items: ReviewItem[];
      /** Ticked on the last submit (all by default). */
      checked?: string[];
      error?: "chooseWorks";
    }
  | { step: "ack"; ack: AckSnapshot };

const VALUE_KEYS = [
  "fullName",
  "orderNumber",
  "email",
  "phone",
  "reason",
  "message",
  "shippedTo",
  "eligibleGroup",
] as const;

function valuesOf(raw: Record<string, unknown>): CancelFormValues {
  const out: CancelFormValues = {};
  for (const k of VALUE_KEYS) {
    const v = raw[k];
    if (typeof v === "string") out[k] = v.slice(0, 2000);
  }
  return out;
}

function valuesFromNotice(d: NoticeDisplay): CancelFormValues {
  return {
    fullName: d.fullName,
    orderNumber: d.orderNumber ?? "",
    email: d.email ?? "",
    phone: d.phone ?? "",
    reason: d.reason ?? "",
    message: d.message ?? "",
    shippedTo: d.shippedTo ?? "",
    eligibleGroup: d.eligibleGroup,
  };
}

function errorCodes(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (out[field]) continue;
    const code = (issue as { params?: { code?: unknown } }).params?.code;
    if (isValidationCode(code)) out[field] = code;
    else if (issue.code === "too_small") out[field] = "required";
    else if (issue.code === "too_big") out[field] = "too_long";
    else if (field === "email") out[field] = "invalid_email";
    else out[field] = "invalid";
  }
  return out;
}

const flowSchema = z
  .object({
    step: z.enum(["review", "confirm", "edit"]),
    token: z.string().max(8192).optional(),
  })
  .catchall(z.unknown());

export const cancelFlowAction = publicAction(
  flowSchema,
  async (input, meta) => {
    const locale: Locale = meta.locale;
    if (input.step === "review") {
      const parsed = cancellationNoticeSchema.safeParse(input);
      if (!parsed.success) {
        return withEffects<CancelFlowState>({
          step: "form",
          values: valuesOf(input),
          errors: errorCodes(parsed.error),
        });
      }
      const items = await previewCancellableItems(parsed.data, locale);
      return withEffects<CancelFlowState>({
        step: "review",
        token: sealReview(parsed.data, locale, new Date(), items),
        display: displayNotice(parsed.data),
        items,
      });
    }

    const opened = openReview(input.token);
    if (!opened) {
      return withEffects<CancelFlowState>({
        step: "form",
        values: valuesOf(input),
        banner: "expired",
      });
    }
    if (input.step === "edit") {
      return withEffects<CancelFlowState>({
        step: "form",
        values: valuesFromNotice(displayNotice(opened.notice)),
        ...(opened.notice.idNumber ? { banner: "idAgain" as const } : {}),
      });
    }
    // Only works the review step offered; every work ticked = the whole order.
    const raw = input.orderItemId;
    const ticked = new Set(
      (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
        (v): v is string => typeof v === "string",
      ),
    );
    const chosen = opened.items.filter((i) => ticked.has(i.id));
    if (opened.items.length > 1 && chosen.length === 0) {
      return withEffects<CancelFlowState>({
        step: "review",
        token: input.token as string,
        display: displayNotice(opened.notice),
        items: opened.items,
        checked: [],
        error: "chooseWorks",
      });
    }
    const partial = chosen.length > 0 && chosen.length < opened.items.length;
    const { result, effects } = await recordCancellationNotice(opened.notice, {
      locale: opened.locale,
      channel: "WEB",
      actor: "anonymous",
      ipHash: meta.ipHash,
      ...(partial ? { requestedItems: chosen } : {}),
    });
    return {
      result: { step: "ack", ack: result.ack } as CancelFlowState,
      effects,
    };
  },
  {
    name: "cancel.flow",
    limits: [{ name: "cancellationIp", by: "ip" }],
  },
);
