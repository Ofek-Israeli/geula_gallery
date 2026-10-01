import "server-only";
import { ProviderNotConfiguredError } from "@/server/integrations/http";
import type { EmailSender } from "../types";

/**
 * `resend` driver (resend 6.31.0, spec §4.5): `Idempotency-Key` = the outbox dedupe key; region
 * eu-west-1. M1 typed stub (spec §4.1); WS5 implements it.
 */
export interface ResendSenderOptions {
  apiKey?: string;
  from: string;
  replyTo?: string;
}

export function createResendEmailSender(
  _opts: ResendSenderOptions,
): EmailSender {
  return {
    id: "resend",
    storesBody: false,
    async send() {
      throw new ProviderNotConfiguredError(
        "resend",
        "the Resend driver is not implemented yet (WS5)",
      );
    },
  };
}
