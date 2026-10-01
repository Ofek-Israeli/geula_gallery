"use server";

import { z } from "zod";
import {
  amountMinorSchema,
  countrySchema,
  currencySchema,
  emailSchema,
  optionalText,
  personNameSchema,
  phoneSchema,
  slugSchema,
} from "@/lib/validation/common";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { ActionFailure, publicAction } from "@/server/next/actions";
import { submitRequest } from "@/server/requests/service";

/**
 * Public request form (spec §5.8): honeypot, minimum form age, 5 per hour per IP (`requestIp`),
 * zod, then `submitRequest` (stores the row, enqueues `request-ack` and `painter-new-request`).
 * Offers are Tier B and refused by the service for now.
 */
const optionalPhone = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  phoneSchema.optional(),
);
const optionalCountry = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  countrySchema.optional(),
);

export const submitRequestAction = publicAction(
  z
    .object({
      kind: z.enum(["question", "quote", "offer"]),
      slug: slugSchema,
      name: personNameSchema,
      email: emailSchema,
      phone: optionalPhone,
      country: optionalCountry,
      message: optionalText(4000),
      offerAmount: z.preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        amountMinorSchema.optional(),
      ),
      offerCurrency: currencySchema.default("ILS"),
    })
    .superRefine((v, ctx) => {
      if (v.kind === "question" && !v.message) {
        ctx.addIssue({
          code: "too_small",
          minimum: 1,
          origin: "string",
          inclusive: true,
          path: ["message"],
        });
      }
      if (v.kind !== "question" && !v.country) {
        ctx.addIssue({
          code: "too_small",
          minimum: 1,
          origin: "string",
          inclusive: true,
          path: ["country"],
        });
      }
      if (v.kind === "offer" && !v.offerAmount) {
        ctx.addIssue({
          code: "too_small",
          minimum: 1,
          origin: "number",
          inclusive: true,
          path: ["offerAmount"],
        });
      }
    }),
  async (input, meta) => {
    try {
      const out = await submitRequest(
        {
          kind:
            input.kind === "quote"
              ? "QUOTE"
              : input.kind === "offer"
                ? "OFFER"
                : "QUESTION",
          artworkSlug: input.slug,
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          country: input.country ?? null,
          message: input.message ?? "",
          ...(input.kind === "offer"
            ? {
                offerAmountMinor: input.offerAmount ?? null,
                offerCurrency: input.offerCurrency,
              }
            : {}),
          locale: meta.locale,
        },
        { ipHash: meta.ipHash },
      );
      return { result: { email: input.email }, effects: out.effects };
    } catch (error) {
      if (error instanceof NotFoundError) throw new ActionFailure("NOT_FOUND");
      if (error instanceof ConflictError) throw new ActionFailure(error.code);
      throw error;
    }
  },
  { limits: [{ name: "requestIp", by: "ip" }], name: "requests.submit" },
);
