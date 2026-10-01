import "server-only";
import { randomUUID } from "node:crypto";
import { log } from "@/server/log";
import { maskEmail } from "@/server/security/redact";
import type { EmailSender } from "../types";

/**
 * `log` driver (spec §4.5): nothing leaves the machine. `email/send.ts` stores the html and text
 * in `email_messages` (`storesBody`), which is what the E2E mailbox helper reads.
 */
export function createLogEmailSender(): EmailSender {
  return {
    id: "log",
    storesBody: true,
    async send(message) {
      const providerMessageId = `log_${randomUUID()}`;
      log.info("email.logged", {
        to: maskEmail(message.to),
        subject: message.subject,
        attachments: message.attachments?.length ?? 0,
        providerMessageId,
      });
      return { providerMessageId };
    },
  };
}
