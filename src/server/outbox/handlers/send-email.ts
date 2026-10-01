import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { JobHandler } from "../types";

/**
 * `SEND_EMAIL` handler (spec §5.4). M1 stub: the processor treats the thrown error like any failure
 * (backoff, DEAD after 8 attempts). Owner: WS6 (order-confirmation and painter-new-order land in M2).
 *
 * Skip when the email_messages row is already SENT; load fresh data and render in `orders.locale`
 * (painter templates in Hebrew); `order-confirmation` carries the inline disclosure summary and sets
 * `disclosure_sent_at` / `disclosure_version` (spec §5.4). Uses `email/send.ts#sendEmail`.
 * Must be idempotent: a job can run more than once (lease expiry, retries).
 */
export const sendEmailHandler: JobHandler<"SEND_EMAIL"> = async (
  _payload,
  _ctx,
) =>
  notImplemented(
    "outbox handler SEND_EMAIL",
    "WS6 (order-confirmation and painter-new-order land in M2)",
  );
