import "server-only";
import { and, count, eq, gt } from "drizzle-orm";
import { raiseAlert } from "@/server/alerts/service";
import { audit } from "@/server/audit";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import { ANONYMOUS_ACTOR } from "@/server/domain/admin";
import { maskEmail } from "./redact";

export const SIGN_IN_FAILED_ACTION = "auth.sign_in_failed";
/** More than this many failures in 24 h raises one WARNING alert per Jerusalem day (spec §6.10). */
export const FAILED_SIGN_IN_ALERT_THRESHOLD = 10;

function jerusalemDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Records a failed admin sign-in or second-factor attempt (Better Auth after-hook in
 * `src/server/next/auth.ts`). The email is stored masked; the IP only as an HMAC hash.
 */
export async function recordFailedSignIn(
  input: {
    email: string | null;
    path: string;
    status: number;
    ipHash: string | null;
  },
  db: DbOrTx = defaultDb,
  now: Date = new Date(),
): Promise<{ alerted: boolean }> {
  await audit(
    {
      actor: ANONYMOUS_ACTOR,
      action: SIGN_IN_FAILED_ACTION,
      entity: "auth",
      entityId: input.email
        ? maskEmail(input.email.trim().toLowerCase())
        : null,
      after: { path: input.path, status: input.status },
      ipHash: input.ipHash,
      at: now,
    },
    db,
  );
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(eq(auditLog.action, SIGN_IN_FAILED_ACTION), gt(auditLog.at, since)),
    );
  const failures = row?.n ?? 0;
  if (failures <= FAILED_SIGN_IN_ALERT_THRESHOLD) return { alerted: false };
  const { created } = await raiseAlert(
    {
      severity: "WARNING",
      kind: "AUTH_FAILED_SIGNINS",
      dedupeKey: `auth-failed-signins:${jerusalemDate(now)}`,
      entity: "auth",
      params: {
        failures24h: failures,
        threshold: FAILED_SIGN_IN_ALERT_THRESHOLD,
      },
    },
    db,
  );
  return { alerted: created };
}
