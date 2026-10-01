import "server-only";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { redact } from "@/server/security/redact";

export interface AuditEntry {
  /** `admin:<userId>`, `system`, `anonymous`, `buyer:<orderNumber>`, `provider:<name>`, … */
  actor: string;
  /** Dotted verb, e.g. `artwork.price_changed`, `auth.sign_in_failed`. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  /** Redacted before storage. */
  after?: unknown;
  ipHash?: string | null;
  at?: Date;
}

/**
 * Appends an audit row (spec §3.3 audit_log). Pass the transaction when the audited change happens
 * in one, so the row commits (or rolls back) with it.
 */
export async function audit(
  entry: AuditEntry,
  db: DbOrTx = defaultDb,
): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    ipHash: entry.ipHash ?? null,
    ...(entry.at ? { at: entry.at } : {}),
  });
}

/** Actor and IP hash of an admin, for `audit({...auditBy(ctx), ...})`. */
export function auditBy(
  ctx: AdminContext,
): Pick<AuditEntry, "actor" | "ipHash"> {
  return { actor: ctx.actor, ipHash: ctx.ipHash };
}
