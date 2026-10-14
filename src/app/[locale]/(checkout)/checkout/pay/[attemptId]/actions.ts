"use server";

import { z } from "zod";
import {
  ActionFailure,
  type ActionState,
  publicAction,
} from "@/server/next/actions";
import {
  type ChargeOutcome,
  chargeAttemptWithToken,
} from "@/server/payments/charge";
import { verifyHmacToken } from "@/server/security/tokens";

/**
 * `payWithCardAction` (the Isracard pay page): only the one-time card token, the hosted fields'
 * client data, the card holder's ID number and the installments reach the server; the amount comes
 * from the attempt. The page's HMAC `t` binds the attempt; 10 charges per 10 min per IP, and
 * `charge.ts` stops new attempts after 5 declines per hour per IP.
 */
const schema = z.object({
  attemptId: z.uuid(),
  t: z.string().min(8).max(128),
  token: z.string().min(8).max(200),
  clientData: z.string().max(10_000).optional(),
  socialId: z
    .string()
    .regex(/^\d{5,9}$/)
    .optional(),
  installments: z.coerce.number().int().min(1).max(36),
});

const run = publicAction(
  schema,
  async (input, meta) => {
    if (!verifyHmacToken("isracard-pay", input.attemptId, input.t)) {
      throw new ActionFailure("NOT_FOUND");
    }
    return chargeAttemptWithToken({
      attemptId: input.attemptId,
      buyerKey: input.token,
      clientData: input.clientData ?? null,
      socialId: input.socialId ?? null,
      installments: input.installments,
      locale: meta.locale,
      ipHash: meta.ipHash,
    });
  },
  {
    name: "checkout.pay",
    honeypot: false,
    minFormAge: false,
    limits: [{ name: "payChargeIp", by: "ip" }],
  },
);

export async function payWithCardAction(
  prev: ActionState<ChargeOutcome>,
  payload: FormData,
): Promise<ActionState<ChargeOutcome>> {
  return run(prev, payload);
}
