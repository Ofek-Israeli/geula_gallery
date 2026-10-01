"use server";

import { z } from "zod";
import {
  emailSchema,
  optionalText,
  personNameSchema,
  phoneSchema,
} from "@/lib/validation/common";
import { ConflictError } from "@/server/domain/errors";
import { ActionFailure, publicAction } from "@/server/next/actions";
import { submitRequest } from "@/server/requests/service";

/**
 * The contact form (spec §5.8, §6.2 `/contact`): a `buyer_requests` QUESTION without an artwork,
 * topic GENERAL or COMMISSION. Same guards as the request form: honeypot, minimum form age and
 * 5 per hour per IP (`requestIp`); `submitRequest` stores the row and enqueues `request-ack` and
 * `painter-new-request`.
 */
const optionalPhone = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  phoneSchema.optional(),
);

export const submitContactAction = publicAction(
  z
    .object({
      topic: z.enum(["GENERAL", "COMMISSION"]).default("GENERAL"),
      name: personNameSchema,
      email: emailSchema,
      phone: optionalPhone,
      message: optionalText(4000),
    })
    .superRefine((v, ctx) => {
      if (!v.message) {
        ctx.addIssue({
          code: "too_small",
          minimum: 1,
          origin: "string",
          inclusive: true,
          path: ["message"],
        });
      }
    }),
  async (input, meta) => {
    try {
      const out = await submitRequest(
        {
          kind: "QUESTION",
          artworkSlug: null,
          topic: input.topic,
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          country: null,
          message: input.message ?? "",
          locale: meta.locale,
        },
        { ipHash: meta.ipHash },
      );
      return { result: { email: input.email }, effects: out.effects };
    } catch (error) {
      if (error instanceof ConflictError) throw new ActionFailure(error.code);
      throw error;
    }
  },
  { limits: [{ name: "requestIp", by: "ip" }], name: "requests.contact" },
);
