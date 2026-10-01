import "server-only";
import { issueCreditNoteHandler } from "./handlers/issue-credit-note";
import { issueTaxDocumentHandler } from "./handlers/issue-tax-document";
import { refundPaymentHandler } from "./handlers/refund-payment";
import { refundSettledHandler } from "./handlers/refund-settled";
import { sendEmailHandler } from "./handlers/send-email";
import type { JobHandlerRegistry } from "./types";

/**
 * Handler per job kind (spec §9.4: registries are created in M1 with stub files; streams replace
 * the bodies of their own handler files and never edit this map).
 */
export const outboxHandlers: JobHandlerRegistry = {
  SEND_EMAIL: sendEmailHandler,
  ISSUE_TAX_DOCUMENT: issueTaxDocumentHandler,
  ISSUE_CREDIT_NOTE: issueCreditNoteHandler,
  REFUND_PAYMENT: refundPaymentHandler,
  REFUND_SETTLED: refundSettledHandler,
};
