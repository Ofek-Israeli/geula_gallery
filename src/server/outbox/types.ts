import "server-only";
import { z } from "zod";
import { EMAIL_TEMPLATE_IDS } from "@/emails/types";
import { LOCALE_VALUES } from "@/lib/locale";

/**
 * Outbox contract (spec §5.4, §9.3 frozen): five job kinds, their payloads (ids only, plus the
 * email recipient), handler and result types, and the retry policy.
 */
export const JOB_KINDS = [
  "SEND_EMAIL",
  "ISSUE_TAX_DOCUMENT",
  "ISSUE_CREDIT_NOTE",
  "REFUND_PAYMENT",
  "REFUND_SETTLED",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const jobPayloadSchemas = {
  SEND_EMAIL: z.object({
    template: z.enum(EMAIL_TEMPLATE_IDS),
    to: z.email(),
    locale: z.enum(LOCALE_VALUES),
    /** The entity the email is about (order, request, cancellation, alert id). */
    refId: z.string().min(1),
  }),
  ISSUE_TAX_DOCUMENT: z.object({ attemptId: z.uuid() }),
  ISSUE_CREDIT_NOTE: z.object({ refundId: z.uuid() }),
  REFUND_PAYMENT: z.object({ refundId: z.uuid() }),
  REFUND_SETTLED: z.object({ refundId: z.uuid() }),
} as const satisfies Record<JobKind, z.ZodType>;

export type JobPayloads = {
  [K in JobKind]: z.infer<(typeof jobPayloadSchemas)[K]>;
};

/** Canonical dedupe keys (spec §4.5, §5.2, §5.7). One job per key, ever. */
export const dedupeKeys = {
  email: (template: string, refId: string, to: string) =>
    `email:${template}:${refId}:${to.trim().toLowerCase()}`,
  receipt: (attemptId: string) => `taxdoc:receipt:${attemptId}`,
  creditNote: (refundId: string) => `taxdoc:credit-note:${refundId}`,
  refund: (refundId: string) => `refund:${refundId}`,
  refundSettled: (refundId: string) => `refund-settled:${refundId}`,
} as const;

export interface JobHandlerContext {
  jobId: number;
  /** 1 on the first run (incremented when claimed). */
  attempts: number;
  dedupeKey: string;
}

/**
 * What a handler returns. Throwing means failure: back to PENDING with backoff, DEAD after
 * `MAX_ATTEMPTS`. `reschedule` (e.g. a credit note waiting for its receipt) runs again later
 * without consuming an attempt.
 */
export type JobOutcome =
  | { kind: "done" }
  | { kind: "reschedule"; delayMs: number; reason: string };

export type JobHandler<K extends JobKind> = (
  payload: JobPayloads[K],
  ctx: JobHandlerContext,
) => Promise<JobOutcome | undefined>;

export type JobHandlerRegistry = { [K in JobKind]: JobHandler<K> };

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 5 * 60_000;
const MINUTE = 60_000;
const SIX_HOURS = 6 * 60 * MINUTE;

/** Backoff after the `attempts`-th failure: `min(2^attempts min, 6 h)` (spec §3.6). */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts) * MINUTE, SIX_HOURS);
}

export interface ProcessOutboxResult {
  claimed: number;
  done: number;
  retried: number;
  rescheduled: number;
  dead: number;
  /** Claimed but returned unprocessed because the time budget ran out. */
  released: number;
}
