import "server-only";
import { eq } from "drizzle-orm";
import type { EmailBrand, EmailTemplateId, EmailTemplateProps } from "@/emails";
import type { Locale } from "@/lib/locale";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { emailMessages } from "@/server/db/schema";
import { env } from "@/server/env";
import { getSetting } from "@/server/settings";
import { createLogEmailSender } from "./drivers/log";
import { createResendEmailSender } from "./drivers/resend";
import { renderEmail } from "./render";
import type { EmailAttachment, EmailSender } from "./types";

/**
 * Sends one email exactly once per dedupe key (spec §4.5, §5.4). Called by the `SEND_EMAIL`
 * outbox handler outside any transaction.
 *
 * 1. A SENT `email_messages` row for the key → `already_sent` (no second send).
 * 2. Render fresh (the handler passes fresh props) and upsert the row as PENDING.
 * 3. `sender.send(...)` with the dedupe key as idempotency key (Resend dedupes a crash between
 *    send and step 4).
 * 4. Mark SENT, or FAILED with the error and rethrow so the outbox backs off.
 */
let senderInstance: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  senderInstance ??=
    env.EMAIL_DRIVER === "resend"
      ? createResendEmailSender({
          apiKey: env.RESEND_API_KEY,
          from: env.EMAIL_FROM,
          replyTo: env.EMAIL_REPLY_TO,
        })
      : createLogEmailSender();
  return senderInstance;
}

/** Footer identity from `settings.business_profile` (never the ID number). */
export async function loadEmailBrand(
  db: DbOrTx = defaultDb,
): Promise<(locale: Locale) => EmailBrand> {
  const profile = await getSetting("business_profile", db);
  return (locale) => ({
    tradeName: profile.tradeName[locale],
    address: profile.address[locale],
    email: profile.email,
    phone: locale === "he" ? profile.phoneLocal : profile.phoneIntl,
    cancelUrl: `${env.APP_URL}/${locale}/cancel`,
    siteUrl: `${env.APP_URL}/${locale}`,
  });
}

export interface SendEmailInput<K extends EmailTemplateId> {
  dedupeKey: string;
  template: K;
  to: string;
  locale: Locale;
  props: EmailTemplateProps[K];
  orderId?: string | null;
  attachments?: EmailAttachment[];
  replyTo?: string;
}

export interface SendEmailDeps {
  db?: DbOrTx;
  sender?: EmailSender;
  brand?: (locale: Locale) => EmailBrand;
  demo?: boolean;
}

export async function sendEmail<K extends EmailTemplateId>(
  input: SendEmailInput<K>,
  deps: SendEmailDeps = {},
): Promise<{ status: "sent" | "already_sent"; emailMessageId: string }> {
  const db = deps.db ?? defaultDb;
  const sender = deps.sender ?? getEmailSender();

  const [existing] = await db
    .select({ id: emailMessages.id, status: emailMessages.status })
    .from(emailMessages)
    .where(eq(emailMessages.dedupeKey, input.dedupeKey))
    .limit(1);
  if (existing?.status === "SENT") {
    return { status: "already_sent", emailMessageId: existing.id };
  }

  const rendered = await renderEmail(input.template, input.props, {
    locale: input.locale,
    brand: deps.brand ?? (await loadEmailBrand(db)),
    demo: deps.demo ?? env.DEMO_MODE,
  });
  const attachmentsMeta = input.attachments?.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    bytes: a.content.byteLength,
  }));
  const row = {
    template: input.template,
    toEmail: input.to,
    locale: rendered.locale,
    subject: rendered.subject,
    driver: sender.id,
    status: "PENDING" as const,
    html: sender.storesBody ? rendered.html : null,
    text: sender.storesBody ? rendered.text : null,
    attachments: attachmentsMeta ?? null,
    orderId: input.orderId ?? null,
    error: null,
  };
  const [saved] = await db
    .insert(emailMessages)
    .values({ dedupeKey: input.dedupeKey, ...row })
    .onConflictDoUpdate({ target: emailMessages.dedupeKey, set: row })
    .returning({ id: emailMessages.id });
  if (!saved) throw new Error("email_messages upsert returned no row");

  try {
    const { providerMessageId } = await sender.send({
      to: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: input.attachments,
      replyTo: input.replyTo,
      idempotencyKey: input.dedupeKey,
    });
    await db
      .update(emailMessages)
      .set({ status: "SENT", providerMessageId, sentAt: new Date() })
      .where(eq(emailMessages.id, saved.id));
    return { status: "sent", emailMessageId: saved.id };
  } catch (error) {
    await db
      .update(emailMessages)
      .set({
        status: "FAILED",
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          2000,
        ),
      })
      .where(eq(emailMessages.id, saved.id));
    throw error;
  }
}
