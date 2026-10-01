import "server-only";
import { Resend } from "resend";
import {
  ProviderInvalidResponseError,
  ProviderNotConfiguredError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@/server/integrations/http";
import { log } from "@/server/log";
import { maskEmail } from "@/server/security/redact";
import type { EmailSender, OutgoingEmail } from "../types";

/**
 * `resend` driver (resend 6.31.0, spec §4.5). `Idempotency-Key` = the outbox dedupe key, so a crash
 * between the send and marking the row SENT never sends twice. The sending region (eu-west-1) is a
 * property of the verified domain in the Resend dashboard, not of the API call (docs/deployment).
 *
 * Errors: quota/rate limits, 5xx and transport failures → `ProviderUnavailableError` (the outbox
 * backs off and retries with the same key); other 4xx → `ProviderRejectedError`.
 */
export interface ResendSenderOptions {
  apiKey?: string;
  from: string;
  replyTo?: string;
  /** Test seam: a client with Resend's `emails.send` shape. */
  client?: ResendLike;
}

export interface ResendLike {
  emails: {
    send(
      payload: Parameters<Resend["emails"]["send"]>[0],
      options?: Parameters<Resend["emails"]["send"]>[1],
    ): Promise<{
      data: { id: string } | null;
      error: {
        name: string;
        message: string;
        statusCode: number | null;
      } | null;
    }>;
  };
}

const RETRYABLE = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "concurrent_idempotent_requests",
  "application_error",
  "internal_server_error",
]);

export function resendPayload(
  message: OutgoingEmail,
  opts: { from: string; replyTo?: string },
): Parameters<Resend["emails"]["send"]>[0] {
  const replyTo = message.replyTo ?? opts.replyTo;
  return {
    from: opts.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(replyTo ? { replyTo } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: Buffer.from(a.content),
          })),
        }
      : {}),
  };
}

export function createResendEmailSender(
  opts: ResendSenderOptions,
): EmailSender {
  let client: ResendLike | undefined = opts.client;
  return {
    id: "resend",
    storesBody: false,
    async send(message) {
      if (!client) {
        if (!opts.apiKey) {
          throw new ProviderNotConfiguredError(
            "resend",
            "RESEND_API_KEY is not set",
          );
        }
        client = new Resend(opts.apiKey) as unknown as ResendLike;
      }
      let result: Awaited<ReturnType<ResendLike["emails"]["send"]>>;
      try {
        result = await client.emails.send(resendPayload(message, opts), {
          idempotencyKey: message.idempotencyKey,
        });
      } catch (error) {
        throw new ProviderUnavailableError(
          "resend",
          `send failed: ${(error as Error)?.message ?? "unknown"}`,
        );
      }
      if (result.error) {
        const { name, statusCode } = result.error;
        log.warn("email.resend_error", {
          to: maskEmail(message.to),
          name,
          statusCode,
        });
        if (RETRYABLE.has(name) || statusCode === null || statusCode >= 500) {
          throw new ProviderUnavailableError(
            "resend",
            `Resend ${name}`,
            statusCode ?? undefined,
          );
        }
        throw new ProviderRejectedError(
          "resend",
          `Resend ${name}`,
          statusCode,
          name,
        );
      }
      if (!result.data?.id) {
        throw new ProviderInvalidResponseError(
          "resend",
          "no message id returned",
        );
      }
      return { providerMessageId: result.data.id };
    },
  };
}
