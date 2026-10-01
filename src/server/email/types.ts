import "server-only";

/**
 * Email contract (spec §4.5, §9.3 frozen). Template ids and props live in the UI layer
 * (`src/emails/types.ts`, so templates can import them) and are re-exported here.
 */
export type {
  BuyerTemplateId,
  EmailBrand,
  EmailContext,
  EmailT,
  EmailTemplate,
  EmailTemplateId,
  EmailTemplateProps,
  PainterTemplateId,
} from "@/emails/types";
export {
  BUYER_TEMPLATE_IDS,
  EMAIL_TEMPLATE_IDS,
  isPainterTemplate,
  PAINTER_TEMPLATE_IDS,
} from "@/emails/types";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/** `EmailSender.send({ to, subject, html, text, attachments?, replyTo?, idempotencyKey })`. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
  /** The outbox dedupe key; Resend's `Idempotency-Key`. */
  idempotencyKey: string;
}

export interface EmailSender {
  readonly id: "log" | "resend";
  /** The log driver keeps html/text in `email_messages` (purged after 30 days). */
  readonly storesBody: boolean;
  send(message: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

export interface RenderedEmail {
  /** The locale actually used (painter templates are always Hebrew). */
  locale: "he" | "en";
  subject: string;
  html: string;
  text: string;
}
