"use server";

import { z } from "zod";
import { checkboxSchema, emailSchema } from "@/lib/validation/common";
import { saveBusinessProfile } from "@/server/admin/settings";
import { adminAction } from "@/server/next/actions";
import { domainErrors } from "../../_shared/action-errors";

/** `/admin/settings/business` (spec §4.7 `business_profile`): validated again by the settings schema. */
const text = (max = 300) => z.string().trim().max(max).default("");
const required = (max = 300) => z.string().trim().min(1).max(max);

export const saveBusinessAction = adminAction(
  z.object({
    legalName: required(),
    tradeNameHe: required(),
    tradeNameEn: required(),
    artistNameHe: required(),
    artistNameEn: required(),
    signatureName: required(),
    idNumber: z
      .string()
      .trim()
      .regex(/^\d{5,9}$/),
    vatMode: z.enum(["OSEK_PATUR", "OSEK_MURSHE"]),
    vatNumber: text(20),
    addressHe: required(500),
    addressEn: required(500),
    returnAddressHe: required(500),
    returnAddressEn: required(500),
    phoneLocal: required(40),
    phoneIntl: required(40),
    email: emailSchema,
    notificationEmail: emailSchema,
    accessibilityContact: required(300),
    privacyContact: required(300),
    pickupAddressHe: text(500),
    pickupAddressEn: text(500),
    pickupInstructionsHe: text(1000),
    pickupInstructionsEn: text(1000),
    completed: checkboxSchema,
  }),
  async (i, ctx) =>
    domainErrors(() =>
      saveBusinessProfile(ctx, {
        legalName: i.legalName,
        tradeName: { he: i.tradeNameHe, en: i.tradeNameEn },
        artistName: { he: i.artistNameHe, en: i.artistNameEn },
        signatureName: i.signatureName,
        idNumber: i.idNumber,
        vatMode: i.vatMode,
        ...(i.vatNumber ? { vatNumber: i.vatNumber } : {}),
        address: { he: i.addressHe, en: i.addressEn },
        returnAddress: { he: i.returnAddressHe, en: i.returnAddressEn },
        phoneLocal: i.phoneLocal,
        phoneIntl: i.phoneIntl,
        email: i.email,
        notificationEmail: i.notificationEmail,
        accessibilityContact: i.accessibilityContact,
        privacyContact: i.privacyContact,
        pickupAddress: { he: i.pickupAddressHe, en: i.pickupAddressEn },
        pickupInstructions: {
          he: i.pickupInstructionsHe,
          en: i.pickupInstructionsEn,
        },
        completed: i.completed,
      }),
    ),
  { name: "settings.business", fresh: true },
);
