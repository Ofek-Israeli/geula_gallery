import "server-only";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { audit, auditBy } from "@/server/audit";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { type AdminAlert, adminAlerts } from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { redact } from "@/server/security/redact";

export type AlertSeverity = AdminAlert["severity"];

export interface RaiseAlertInput {
  severity: AlertSeverity;
  /** Stable machine kind, e.g. `CONFIG_DRIFT`, `REFUND_DUE`, `AUTH_FAILED_SIGNINS`. */
  kind: string;
  /** Idempotency: the same dedupe key never creates a second alert. */
  dedupeKey: string;
  entity?: string;
  entityId?: string;
  /** Rendering parameters only; redacted, never buyer PII. */
  params?: Record<string, unknown>;
}

/**
 * Raises an admin alert at most once per dedupe key (spec §3.3 admin_alerts). Safe inside a
 * transaction. Returns whether a new alert was created. Email notification of CRITICAL alerts is
 * the `admin-alert` template's job (outbox, WS6).
 */
export async function raiseAlert(
  input: RaiseAlertInput,
  db: DbOrTx = defaultDb,
): Promise<{ created: boolean }> {
  const rows = await db
    .insert(adminAlerts)
    .values({
      severity: input.severity,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      params: redact(input.params ?? {}),
    })
    .onConflictDoNothing({ target: adminAlerts.dedupeKey })
    .returning({ id: adminAlerts.id });
  return { created: rows.length > 0 };
}

export async function countOpenAlerts(
  _ctx: AdminContext,
  db: DbOrTx = defaultDb,
): Promise<Record<AlertSeverity, number>> {
  const rows = await db
    .select({ severity: adminAlerts.severity, n: count() })
    .from(adminAlerts)
    .where(isNull(adminAlerts.acknowledgedAt))
    .groupBy(adminAlerts.severity);
  const out: Record<AlertSeverity, number> = {
    INFO: 0,
    WARNING: 0,
    CRITICAL: 0,
  };
  for (const r of rows) out[r.severity] = r.n;
  return out;
}

export async function listOpenAlerts(
  _ctx: AdminContext,
  opts: { limit?: number } = {},
  db: DbOrTx = defaultDb,
): Promise<AdminAlert[]> {
  return db
    .select()
    .from(adminAlerts)
    .where(isNull(adminAlerts.acknowledgedAt))
    .orderBy(
      sql`CASE ${adminAlerts.severity} WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END`,
      desc(adminAlerts.createdAt),
    )
    .limit(opts.limit ?? 100);
}

/** Acknowledges an open alert (conditional update; audited). */
export async function acknowledgeAlert(
  ctx: AdminContext,
  alertId: string,
  db: DbOrTx = defaultDb,
): Promise<ServiceResult<{ acknowledged: boolean }>> {
  const rows = await db
    .update(adminAlerts)
    .set({ acknowledgedAt: new Date(), acknowledgedBy: ctx.actor })
    .where(and(eq(adminAlerts.id, alertId), isNull(adminAlerts.acknowledgedAt)))
    .returning({ id: adminAlerts.id });
  if (rows.length > 0) {
    await audit(
      {
        ...auditBy(ctx),
        action: "alert.acknowledged",
        entity: "admin_alert",
        entityId: alertId,
      },
      db,
    );
  }
  return withEffects({ acknowledged: rows.length > 0 });
}
