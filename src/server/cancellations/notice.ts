import "server-only";
import { z } from "zod";
import type { IdentityDocument } from "@/lib/il-id";
import { maskIdentity } from "@/lib/il-id";
import type { Locale } from "@/lib/locale";
import {
  emailSchema,
  idOrPassportSchema,
  localeSchema,
  optionalText,
  orderNumberSchema,
  personNameSchema,
  phoneSchema,
} from "@/lib/validation/common";
import { issueParams } from "@/lib/validation/messages";
import { decryptAesGcm, encryptAesGcm } from "@/server/security/crypto";
import { appKey } from "@/server/security/keys";

/**
 * The cancellation notice as the buyer submits it (spec §5.7 step 3), and the sealed review payload
 * of step 2. One schema serves the public form, the review/confirm round trip and the admin "log a
 * notice" form.
 *
 * Required: full name, plus the ID/passport number **or** the order number. Everything else is
 * optional. The ID never travels in a URL: the form is a POST, and the review payload that carries
 * it between the two steps is AES-256-GCM sealed (confidential and authenticated) with a dedicated
 * HKDF key (`cancel-review`) and expires after two hours.
 */
export const CANCELLATION_REASONS = [
  "CHANGE_OF_MIND",
  "DEFECT",
  "NOT_AS_DESCRIBED",
  "NOT_DELIVERED",
  "OTHER",
] as const;
export const ELIGIBLE_GROUPS = [
  "NONE",
  "SENIOR_65",
  "DISABILITY",
  "NEW_IMMIGRANT",
] as const;
/** "Where was the order shipped?" (sets the regime when no order is matched). */
export const SHIPPED_TO = ["IL", "EU", "OTHER"] as const;
export const CANCELLATION_CHANNELS = [
  "WEB",
  "PHONE",
  "EMAIL",
  "REGISTERED_MAIL",
  "IN_PERSON",
] as const;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

export const cancellationNoticeSchema = z
  .object({
    fullName: personNameSchema,
    idNumber: optional(idOrPassportSchema),
    orderNumber: optional(orderNumberSchema),
    email: optional(emailSchema),
    phone: optional(phoneSchema),
    reason: optional(z.enum(CANCELLATION_REASONS)),
    message: optionalText(2000),
    shippedTo: optional(z.enum(SHIPPED_TO)),
    eligibleGroup: z.preprocess(
      (v) => blankToUndefined(v) ?? "NONE",
      z.enum(ELIGIBLE_GROUPS),
    ),
  })
  .superRefine((v, ctx) => {
    if (!v.idNumber && !v.orderNumber) {
      ctx.addIssue({
        code: "custom",
        path: ["idNumber"],
        ...issueParams("id_or_order_required"),
      });
    }
  });

export type CancellationNotice = z.output<typeof cancellationNoticeSchema>;

/** What the review step and the acknowledgement show (the ID masked). */
export interface NoticeDisplay {
  fullName: string;
  idNumberMasked: string | null;
  idKind: IdentityDocument["kind"] | null;
  orderNumber: string | null;
  email: string | null;
  phone: string | null;
  reason: CancellationNotice["reason"] | null;
  message: string | null;
  shippedTo: CancellationNotice["shippedTo"] | null;
  eligibleGroup: CancellationNotice["eligibleGroup"];
}

export function displayNotice(n: CancellationNotice): NoticeDisplay {
  return {
    fullName: n.fullName,
    idNumberMasked: n.idNumber ? maskIdentity(n.idNumber.value) : null,
    idKind: n.idNumber?.kind ?? null,
    orderNumber: n.orderNumber ?? null,
    email: n.email ?? null,
    phone: n.phone ?? null,
    reason: n.reason ?? null,
    message: n.message ?? null,
    shippedTo: n.shippedTo ?? null,
    eligibleGroup: n.eligibleGroup,
  };
}

// ---------------------------------------------------------------- sealed review payload

export const REVIEW_TTL_SECONDS = 2 * 60 * 60;
const REVIEW_AAD = "cancellation-review:v1";

interface SealedBody {
  v: 1;
  exp: number;
  locale: Locale;
  notice: CancellationNotice;
}

const sealedBodySchema = z.object({
  v: z.literal(1),
  exp: z.number().int(),
  locale: localeSchema,
  notice: z.object({
    fullName: z.string().min(1).max(120),
    idNumber: z
      .object({
        kind: z.enum(["IL_ID", "PASSPORT"]),
        value: z.string().min(1).max(20),
      })
      .optional(),
    orderNumber: z.string().max(20).optional(),
    email: z.string().max(254).optional(),
    phone: z.string().max(32).optional(),
    reason: z.enum(CANCELLATION_REASONS).optional(),
    message: z.string().max(2000).optional(),
    shippedTo: z.enum(SHIPPED_TO).optional(),
    eligibleGroup: z.enum(ELIGIBLE_GROUPS),
  }),
});

/** Seals the validated notice for the hidden field of the review step. */
export function sealReview(
  notice: CancellationNotice,
  locale: Locale,
  now: Date = new Date(),
): string {
  const body: SealedBody = {
    v: 1,
    exp: Math.floor(now.getTime() / 1000) + REVIEW_TTL_SECONDS,
    locale,
    notice,
  };
  return encryptAesGcm(
    appKey("cancel-review"),
    JSON.stringify(body),
    REVIEW_AAD,
  );
}

/** Opens a sealed review payload; null when forged, tampered with or expired. */
export function openReview(
  token: string | null | undefined,
  now: Date = new Date(),
): { notice: CancellationNotice; locale: Locale } | null {
  if (!token || token.length > 8192) return null;
  try {
    const raw = JSON.parse(
      decryptAesGcm(appKey("cancel-review"), token, REVIEW_AAD),
    );
    const body = sealedBodySchema.parse(raw);
    if (body.exp < Math.floor(now.getTime() / 1000)) return null;
    return { notice: body.notice as CancellationNotice, locale: body.locale };
  } catch {
    return null;
  }
}
