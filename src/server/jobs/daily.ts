import "server-only";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  addJerusalemDays,
  addJerusalemMonths,
  jerusalemDateKey,
} from "@/lib/format";
import { paturCeilingLevel } from "@/lib/vat";
import { raiseAlert } from "@/server/alerts/service";
import { refundDeadlines } from "@/server/cancellations/service";
import type { Db, DbOrTx } from "@/server/db/client";
import {
  cancellations,
  orders,
  paymentAttempts,
  shipments,
  taxDocuments,
} from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import { transition } from "@/server/domain/transition";
import { env } from "@/server/env";
import { goLiveBlockers } from "@/server/golive";
import { checkInvariants } from "@/server/invariants";
import { runCardcomDailyChecks } from "@/server/payments/sweep";
import { getSettingOrNull } from "@/server/settings";
import { notifyCriticalAlerts } from "./alert-emails";
import type { CronJob, CronJobContext } from "./index";

/**
 * `daily` cron job, `0 5 * * *` UTC (spec §5.11). Owner: WS6. Every step is idempotent (alerts are
 * deduplicated by key, transitions are conditional) and stops starting work once the budget is
 * spent.
 *
 * 1. Deadline alerts: cancellation refunds due in ≤ 5 days (WARNING), ≤ 2 days (CRITICAL), overdue
 *    (CRITICAL, once per Jerusalem day); orders unshipped beyond `dispatch_days + 2`; export
 *    declarations pending > 7 days; payments in review > 24 h; tax documents needing action;
 *    turnover ≥ 80 % / 95 % of the patur ceiling (mock and demo sales excluded); shipping rates
 *    uncalibrated or calibrated > 90 days ago.
 * 2. COMPLETED transitions (spec §3.6): PAID, delivered or collected, the window has passed (4
 *    months after the window start when a conversation took place, else 14 days), no open
 *    cancellation, no fulfillment block, no pending export declaration.
 * 3. Cardcom checks (WS2's `payments/sweep.ts#runCardcomDailyChecks`): the 30-day tail poll of
 *    expired attempts and, in live mode with an ApiPassword, the ListTransactions sweep (unmatched
 *    money → CRITICAL alert). Stats: `cardcomTail`, `cardcomSweep`.
 * 4. `checkInvariants()` (Tier B) → one CRITICAL alert per violation.
 * 5. Go-live digest (outside demo mode): CRITICAL alert listing the blockers.
 * 6. `admin-alert` emails for open CRITICAL alerts (once per alert), last so that the alerts of
 *    the earlier steps are mailed the same day.
 */
const DAY = 86_400_000;

export const dailyJob: CronJob = async (ctx) => {
  const db = ctx.db as Db;
  const now = new Date();
  const stats: Record<string, unknown> = {};
  const steps: [string, () => Promise<unknown>][] = [
    ["deadlines", () => deadlineAlerts(db, now)],
    ["completed", () => completeOrders(ctx, db, now)],
    [
      "cardcom",
      async () => {
        const r = await runCardcomDailyChecks(ctx, { db });
        stats.cardcomTail = r.cardcomTail;
        stats.cardcomSweep = r.cardcomSweep;
        return r.cardcomSweep.skipped ?? "ok";
      },
    ],
    ["invariants", () => invariantAlerts(db)],
    ["golive", () => goLiveDigest(db, now)],
    ["alertEmails", () => notifyCriticalAlerts(db, { now })],
  ];
  for (const [name, fn] of steps) {
    if (ctx.expired()) {
      stats[name] = "skipped (budget)";
      continue;
    }
    stats[name] = await fn();
  }
  return stats;
};

// ---------------------------------------------------------------- 1. deadline alerts

export async function deadlineAlerts(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const today = jerusalemDateKey(now);
  const counts: Record<string, number> = {};
  const bump = (k: string, created: boolean) => {
    if (created) counts[k] = (counts[k] ?? 0) + 1;
  };

  // Cancellation refunds (spec §5.7 step 10).
  for (const d of await refundDeadlines(db)) {
    if (d.refundSettled) continue;
    const left = d.refundDueAt.getTime() - now.getTime();
    if (left < 0) {
      const { created } = await raiseAlert(
        {
          severity: "CRITICAL",
          kind: "REFUND_OVERDUE",
          dedupeKey: `refund-overdue:${d.id}:${today}`,
          entity: "cancellation",
          entityId: d.id,
          params: { number: d.number, dueAt: d.refundDueAt.toISOString() },
        },
        db,
      );
      bump("refundOverdue", created);
    } else if (left <= 2 * DAY) {
      const { created } = await raiseAlert(
        {
          severity: "CRITICAL",
          kind: "REFUND_DUE_SOON",
          dedupeKey: `refund-due-2d:${d.id}`,
          entity: "cancellation",
          entityId: d.id,
          params: { number: d.number, dueAt: d.refundDueAt.toISOString() },
        },
        db,
      );
      bump("refundDue2d", created);
    } else if (left <= 5 * DAY) {
      const { created } = await raiseAlert(
        {
          severity: "WARNING",
          kind: "REFUND_DUE_SOON",
          dedupeKey: `refund-due-5d:${d.id}`,
          entity: "cancellation",
          entityId: d.id,
          params: { number: d.number, dueAt: d.refundDueAt.toISOString() },
        },
        db,
      );
      bump("refundDue5d", created);
    }
  }

  // Paid orders not shipped within dispatch_days + 2.
  const late = await db.execute<{ id: string; number: string }>(sql`
    SELECT o.id, o.number FROM orders o
      JOIN shipments s ON s.order_id = o.id
     WHERE o.status = 'PAID' AND o.fulfillment_blocked_reason IS NULL
       AND s.status IN ('AWAITING_FULFILLMENT', 'PACKED')
       AND o.paid_at + make_interval(days => 2 + coalesce((
             SELECT max(a.dispatch_days) FROM order_items oi
               JOIN artworks a ON a.id = oi.artwork_id WHERE oi.order_id = o.id), 5)) < ${now}`);
  for (const o of late.rows) {
    const { created } = await raiseAlert(
      {
        severity: "WARNING",
        kind: "UNSHIPPED_LATE",
        dedupeKey: `unshipped-late:${o.id}`,
        entity: "order",
        entityId: o.id,
        params: { number: o.number },
      },
      db,
    );
    bump("unshippedLate", created);
  }

  // Export declarations pending > 7 days.
  const pendingDecl = await db
    .select({ id: shipments.id, orderId: shipments.orderId })
    .from(shipments)
    .where(
      and(
        inArray(shipments.exportDeclStatus, ["REQUIRED", "PENDING_CARRIER"]),
        lt(
          sql`coalesce(${shipments.shippedAt}, ${shipments.createdAt})`,
          new Date(now.getTime() - 7 * DAY),
        ),
      ),
    );
  for (const s of pendingDecl) {
    const { created } = await raiseAlert(
      {
        severity: "WARNING",
        kind: "EXPORT_DECLARATION_PENDING",
        dedupeKey: `export-decl:${s.id}`,
        entity: "order",
        entityId: s.orderId,
      },
      db,
    );
    bump("exportDeclaration", created);
  }

  // Payments in review > 24 h.
  const review = await db
    .select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.status, "PAYMENT_REVIEW"),
        lt(paymentAttempts.updatedAt, new Date(now.getTime() - DAY)),
      ),
    );
  for (const a of review) {
    const { created } = await raiseAlert(
      {
        severity: "WARNING",
        kind: "PAYMENT_REVIEW_LONG",
        dedupeKey: `review-24h:${a.id}`,
        entity: "order",
        entityId: a.orderId,
      },
      db,
    );
    bump("paymentReview", created);
  }

  // Tax documents needing action.
  const docs = await db
    .select({
      id: taxDocuments.id,
      orderId: taxDocuments.orderId,
      status: taxDocuments.status,
    })
    .from(taxDocuments)
    .where(inArray(taxDocuments.status, ["FAILED", "NEEDS_MANUAL"]));
  for (const d of docs) {
    const { created } = await raiseAlert(
      {
        severity: "WARNING",
        kind: "TAX_DOCUMENT_ACTION",
        dedupeKey: `taxdoc-action:${d.id}:${d.status}`,
        entity: "order",
        entityId: d.orderId,
        params: { status: d.status },
      },
      db,
    );
    bump("taxDocuments", created);
  }

  // Turnover vs the patur ceiling (mock and demo sales excluded).
  const profile = await getSettingOrNull("business_profile", db);
  if (profile?.vatMode === "OSEK_PATUR") {
    const year = Number(today.slice(0, 4));
    const turnover = await yearTurnoverIlsMinor(db, year);
    const level = paturCeilingLevel(turnover, year);
    if (level === "warn80" || level === "warn95" || level === "over") {
      const { created } = await raiseAlert(
        {
          severity: level === "warn80" ? "WARNING" : "CRITICAL",
          kind: "TURNOVER_CEILING",
          dedupeKey: `turnover:${year}:${level}`,
          params: { year, level, turnoverMinor: turnover },
        },
        db,
      );
      bump("turnover", created);
    }
  }

  // Shipping rates uncalibrated or stale (> 90 days).
  const shipping = await getSettingOrNull("shipping", db);
  const calibrated = shipping?.calibratedAt
    ? new Date(shipping.calibratedAt)
    : null;
  if (!calibrated || now.getTime() - calibrated.getTime() > 90 * DAY) {
    const { created } = await raiseAlert(
      {
        severity: "WARNING",
        kind: "RATES_UNCALIBRATED",
        dedupeKey: `rates-uncalibrated:${today.slice(0, 7)}`,
        params: { calibratedAt: shipping?.calibratedAt ?? null },
      },
      db,
    );
    bump("rates", created);
  }
  return counts;
}

/** Year-to-date turnover in ILS minor units: unvoided, non-mock sales of non-demo works. */
export async function yearTurnoverIlsMinor(
  db: DbOrTx,
  year: number,
): Promise<number> {
  const res = await db.execute<{ total: string | null }>(sql`
    SELECT sum(CASE WHEN s.currency = 'ILS' THEN s.price_minor
                    ELSE round(s.price_minor * coalesce(o.fx_ils_per_unit, 0)) END) AS total
      FROM sales s
      JOIN artworks a ON a.id = s.artwork_id
      LEFT JOIN orders o ON o.id = s.order_id
     WHERE s.voided_at IS NULL AND NOT s.is_mock AND NOT a.is_demo
       AND (o.id IS NULL OR NOT o.is_demo)
       AND extract(year FROM s.sold_at AT TIME ZONE 'Asia/Jerusalem') = ${year}`);
  return Number(res.rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------- 2. COMPLETED

/** When the order's cancellation window has passed (spec §3.6 COMPLETED rule). */
export function completionDue(o: {
  deliveredAt: Date | null;
  disclosureSentAt: Date | null;
  disclosureHandedOverAt: Date | null;
  conversationTookPlace: boolean;
}): Date | null {
  if (!o.deliveredAt) return null;
  const disclosure =
    o.disclosureSentAt ?? o.disclosureHandedOverAt ?? o.deliveredAt;
  const start = disclosure > o.deliveredAt ? disclosure : o.deliveredAt;
  return o.conversationTookPlace
    ? addJerusalemMonths(start, 4)
    : addJerusalemDays(start, 14);
}

export async function completeOrders(
  ctx: Pick<CronJobContext, "expired">,
  db: Db,
  now: Date = new Date(),
): Promise<{ completed: number; candidates: number }> {
  const candidates = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, "PAID"),
        isNotNull(orders.deliveredAt),
        isNull(orders.fulfillmentBlockedReason),
      ),
    )
    .limit(200);
  let completed = 0;
  for (const o of candidates) {
    if (ctx.expired()) break;
    const due = completionDue(o);
    if (!due || due.getTime() > now.getTime()) continue;
    const done = await withTx(
      async (tx) => {
        await tx.execute(
          sql`SELECT id FROM orders WHERE id = ${o.id} FOR UPDATE`,
        );
        const [open] = await tx
          .select({ id: cancellations.id })
          .from(cancellations)
          .where(
            and(
              eq(cancellations.orderId, o.id),
              inArray(cancellations.status, ["RECEIVED", "ACCEPTED"]),
            ),
          )
          .limit(1);
        if (open) return false;
        const [pendingDecl] = await tx
          .select({ id: shipments.id })
          .from(shipments)
          .where(
            and(
              eq(shipments.orderId, o.id),
              inArray(shipments.exportDeclStatus, [
                "REQUIRED",
                "PENDING_CARRIER",
              ]),
            ),
          );
        if (pendingDecl) return false;
        await transition(
          tx,
          "order",
          o.id,
          ["PAID"],
          "COMPLETED",
          { completedAt: now, updatedAt: now },
          "system",
          { where: isNull(orders.fulfillmentBlockedReason) },
        );
        return true;
      },
      { db, name: "daily.complete" },
    );
    if (done) completed++;
  }
  return { completed, candidates: candidates.length };
}

// ---------------------------------------------------------------- 3. invariants

async function invariantAlerts(db: DbOrTx) {
  const report = await checkInvariants({ db });
  let raised = 0;
  for (const v of report.violations) {
    const { created } = await raiseAlert(
      {
        severity: "CRITICAL",
        kind: "INVARIANT_VIOLATION",
        dedupeKey: `invariant:${v.check}:${v.id}`,
        entity: v.entity,
        entityId: v.id,
        params: { check: v.check },
      },
      db,
    );
    if (created) raised++;
  }
  return { violations: report.violations.length, raised };
}

// ---------------------------------------------------------------- 4. go-live digest

async function goLiveDigest(db: DbOrTx, now: Date) {
  const report = await goLiveBlockers({ db });
  if (env.DEMO_MODE || report.ok) {
    return { blockers: report.blockers.length, alerted: false };
  }
  const { created } = await raiseAlert(
    {
      severity: "CRITICAL",
      kind: "GOLIVE_BLOCKERS",
      dedupeKey: `golive:${jerusalemDateKey(now)}`,
      params: { blockers: report.blockers.join(",") },
    },
    db,
  );
  return { blockers: report.blockers.length, alerted: created };
}
