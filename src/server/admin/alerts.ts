import "server-only";
import { desc, eq } from "drizzle-orm";
import { acknowledgeAlert, listOpenAlerts } from "@/server/alerts/service";
import { audit, auditBy } from "@/server/audit";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { type AdminAlert, outboxJobs } from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { ConflictError } from "@/server/domain/errors";
import { retryDeadJob } from "@/server/outbox/process";

/**
 * `/admin/alerts` (spec §6.10 "Acknowledge; retry DEAD jobs"): open alerts by severity and the
 * outbox jobs that died after 8 attempts. Retrying resets the attempt budget (the processor's
 * `retryDeadJob`); the handlers are idempotent, so a retry never repeats an effect.
 */
export interface DeadJobRow {
  id: number;
  kind: string;
  dedupeKey: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

export async function getAlertsPage(
  ctx: AdminContext,
  db: DbOrTx = defaultDb,
): Promise<{ alerts: AdminAlert[]; dead: DeadJobRow[] }> {
  const alerts = await listOpenAlerts(ctx, { limit: 200 }, db);
  const dead = await db
    .select({
      id: outboxJobs.id,
      kind: outboxJobs.kind,
      dedupeKey: outboxJobs.dedupeKey,
      attempts: outboxJobs.attempts,
      lastError: outboxJobs.lastError,
      updatedAt: outboxJobs.updatedAt,
    })
    .from(outboxJobs)
    .where(eq(outboxJobs.status, "DEAD"))
    .orderBy(desc(outboxJobs.updatedAt))
    .limit(100);
  return { alerts, dead };
}

export async function acknowledge(
  ctx: AdminContext,
  alertId: string,
): Promise<ServiceResult<{ acknowledged: boolean }>> {
  const out = await acknowledgeAlert(ctx, alertId);
  return withEffects(out.result, { revalidate: true });
}

export async function retryDead(
  ctx: AdminContext,
  jobId: number,
): Promise<ServiceResult<{ retried: true }>> {
  const ok = await retryDeadJob(jobId);
  if (!ok) throw new ConflictError("NOT_DEAD", "the job is not DEAD");
  await audit({
    ...auditBy(ctx),
    action: "outbox.dead_retried",
    entity: "outbox_job",
    entityId: String(jobId),
  });
  return withEffects(
    { retried: true as const },
    { outbox: true, revalidate: true },
  );
}
