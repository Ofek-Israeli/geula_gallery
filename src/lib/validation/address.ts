/**
 * Postal addresses (spec §4.4 "Addresses", §5.1 details form): Latin script internationally,
 * Hebrew allowed for Israeli destinations; recipient phone and email are required.
 */
import { z } from "zod";
import { nonLatinFields } from "../script";
import {
  countrySchema,
  emailSchema,
  optionalText,
  personNameSchema,
  phoneSchema,
  requiredText,
} from "./common";
import { issueParams } from "./messages";

/** The address shape used by orders (`orders.ship_*`) and provider inputs. */
export interface PostalAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** E.164. */
  phone: string;
}

const SCRIPT_CHECKED = [
  "name",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
] as const;

export const postalAddressSchema = z
  .object({
    name: personNameSchema,
    line1: requiredText(200),
    line2: optionalText(200),
    city: requiredText(120),
    region: optionalText(120),
    postalCode: optionalText(20),
    country: countrySchema,
    phone: phoneSchema,
  })
  .superRefine((a, ctx) => {
    const fields = Object.fromEntries(SCRIPT_CHECKED.map((k) => [k, a[k]]));
    for (const field of nonLatinFields(fields, a.country)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        ...issueParams("latin_only"),
      });
    }
  }) satisfies z.ZodType<PostalAddress, unknown>;

/** Buyer contact details on the checkout form (company and VAT ID optional). */
export const buyerContactSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  companyName: optionalText(200),
  vatId: optionalText(40),
});
export type BuyerContact = z.infer<typeof buyerContactSchema>;
