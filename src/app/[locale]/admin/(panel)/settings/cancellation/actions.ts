"use server";

import { z } from "zod";
import { adminAction } from "@/server/next/actions";
import { saveSetting } from "@/server/settings";

/** `/admin/settings/cancellation` (spec §4.7 `cancellation_policy`); fresh session, audited. */
export const saveCancellationPolicyAction = adminAction(
  z.object({ changeOfMindFee: z.enum(["STATUTORY_MAX", "NONE"]) }),
  async (input, ctx) =>
    saveSetting(ctx, "cancellation_policy", {
      changeOfMindFee: input.changeOfMindFee,
    }),
  { name: "settings.cancellation", fresh: true },
);
