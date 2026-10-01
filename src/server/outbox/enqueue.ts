import "server-only";
import type { EmailTemplateId } from "@/emails/types";
import type { Locale } from "@/lib/locale";
import type { DbOrTx } from "@/server/db/client";
import { outboxJobs } from "@/server/db/schema";
import {
  dedupeKeys,
  type JobKind,
  type JobPayloads,
  jobPayloadSchemas,
} from "./types";

/**
 * Enqueues a job in the caller's transaction (spec §5.4): `ON CONFLICT (dedupe_key) DO NOTHING`,
 * so enqueueing the same logical job twice is a no-op. The service then returns
 * `effects.outbox = true` so the Next layer processes a batch after the response.
 */
export async function enqueue<K extends JobKind>(
  tx: DbOrTx,
  job: {
    kind: K;
    dedupeKey: string;
    payload: JobPayloads[K];
    runAfter?: Date;
  },
): Promise<{ enqueued: boolean }> {
  const payload = jobPayloadSchemas[job.kind].parse(job.payload);
  const rows = await tx
    .insert(outboxJobs)
    .values({
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      payload,
      ...(job.runAfter ? { runAfter: job.runAfter } : {}),
    })
    .onConflictDoNothing({ target: outboxJobs.dedupeKey })
    .returning({ id: outboxJobs.id });
  return { enqueued: rows.length > 0 };
}

/** `enqueueEmail(tx, { template, to, locale, refId })`, dedupe key `email:<template>:<refId>:<to>`. */
export function enqueueEmail(
  tx: DbOrTx,
  input: {
    template: EmailTemplateId;
    to: string;
    locale: Locale;
    refId: string;
    runAfter?: Date;
  },
): Promise<{ enqueued: boolean }> {
  const to = input.to.trim();
  return enqueue(tx, {
    kind: "SEND_EMAIL",
    dedupeKey: dedupeKeys.email(input.template, input.refId, to),
    payload: {
      template: input.template,
      to,
      locale: input.locale,
      refId: input.refId,
    },
    runAfter: input.runAfter,
  });
}
