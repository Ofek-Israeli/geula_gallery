"use server";

import { z } from "zod";
import { ActionFailure, adminAction } from "@/server/next/actions";
import { getSetting, saveSetting } from "@/server/settings";
import { shippingSettingsFromForm } from "@/server/shipping/settings-form";

/**
 * Shipping settings editor (spec §4.7, §6.10): a fresh session is required for settings (spec §7).
 * The flat form is parsed and validated by `shippingSettingsFromForm`, then saved with an audit
 * row by `saveSetting`.
 */
export const saveShippingSettingsAction = adminAction(
  z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  async (fields, ctx) => {
    const current = await getSetting("shipping");
    const res = shippingSettingsFromForm(fields, current, new Date());
    if (!res.ok) {
      throw new ActionFailure(res.code, {
        fieldErrors: { settings: [res.details] },
      });
    }
    const { effects } = await saveSetting(ctx, "shipping", res.value);
    return { result: { saved: true as const }, effects };
  },
  { fresh: true, name: "settings.shipping" },
);
