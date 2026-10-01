import "server-only";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { Effects } from "@/server/domain/effects";
import { log } from "@/server/log";

export type { Effects, ServiceResult } from "@/server/domain/effects";

/** Outbox batch size processed after a response (spec §2.2). */
export const AFTER_RESPONSE_OUTBOX_LIMIT = 10;

type OutboxProcessor = (opts: { limit: number }) => Promise<unknown>;

/**
 * Loads the outbox processor lazily, so this module does not pull the email/PDF renderers into
 * every route that merely applies effects.
 */
async function loadOutboxProcessor(): Promise<OutboxProcessor> {
  return (await import("@/server/outbox/process")).processOutbox;
}

/**
 * Runs the side effects a service asked for (spec §2.2): `after(() => processOutbox({ limit: 10 }))`
 * and `revalidatePath('/', 'layout')`. Called by `adminAction` / `publicAction` and by route handlers.
 */
export function applyEffects(effects: Effects | undefined): void {
  if (!effects) return;
  if (effects.revalidate) {
    revalidatePath("/", "layout");
  }
  if (effects.outbox) {
    after(async () => {
      try {
        const processOutbox = await loadOutboxProcessor();
        await processOutbox({ limit: AFTER_RESPONSE_OUTBOX_LIMIT });
      } catch (error) {
        // The cron outbox job retries; never fail the response.
        log.error("effects.outbox_after_failed", {}, error);
      }
    });
  }
}
