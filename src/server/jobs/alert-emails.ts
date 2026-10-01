import "server-only";
import { and, eq, gte, isNull } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import type { DbOrTx } from "@/server/db/client";
import { adminAlerts } from "@/server/db/schema";
import { NotFoundError } from "@/server/domain/errors";
import type { BuiltEmail } from "@/server/email/props";
import type { Env } from "@/server/env";
import { enqueueEmail } from "@/server/outbox/enqueue";
import { getSetting } from "@/server/settings";

/**
 * `admin-alert` emails (spec §4.5): one email per open CRITICAL alert (dedupe key
 * `email:admin-alert:<alertId>:<to>`, so it is sent once however often the daily job runs).
 * The message is built from the alert's redacted params: no buyer PII ever reaches it.
 */
export async function adminAlertProps(
  refId: string,
  _locale: Locale,
  { db, env }: { db: DbOrTx; env: Env },
): Promise<BuiltEmail<"admin-alert">> {
  const [alert] = await db
    .select()
    .from(adminAlerts)
    .where(eq(adminAlerts.id, refId));
  if (!alert) throw new NotFoundError("admin_alert", refId);
  return {
    locale: "he",
    orderId: null,
    props: {
      severity: alert.severity,
      kind: alert.kind,
      message: alertMessage(alert.params, alert.entity, alert.entityId),
      adminAlertsUrl: absoluteUrl(
        env.APP_URL,
        localePath("he", paths.admin.alerts()),
      ),
    },
  };
}

/** `key: value` pairs of scalar params (already redacted when the alert was raised). */
export function alertMessage(
  params: unknown,
  entity: string | null,
  entityId: string | null,
): string {
  const parts: string[] = [];
  if (entity) parts.push(`${entity}${entityId ? ` ${entityId}` : ""}`);
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (["string", "number", "boolean"].includes(typeof v)) {
        parts.push(`${k}: ${String(v)}`);
      }
      if (parts.length >= 8) break;
    }
  }
  return parts.join(" · ").slice(0, 500);
}

/** Enqueues the email for open CRITICAL alerts raised in the last `days` days. */
export async function notifyCriticalAlerts(
  db: DbOrTx,
  opts: { now?: Date; days?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 7) * 86_400_000);
  const rows = await db
    .select({ id: adminAlerts.id })
    .from(adminAlerts)
    .where(
      and(
        eq(adminAlerts.severity, "CRITICAL"),
        isNull(adminAlerts.acknowledgedAt),
        gte(adminAlerts.createdAt, since),
      ),
    )
    .limit(100);
  if (rows.length === 0) return 0;
  const profile = await getSetting("business_profile", db);
  let n = 0;
  for (const r of rows) {
    const { enqueued } = await enqueueEmail(db, {
      template: "admin-alert",
      to: profile.notificationEmail,
      locale: "he",
      refId: r.id,
    });
    if (enqueued) n++;
  }
  return n;
}
