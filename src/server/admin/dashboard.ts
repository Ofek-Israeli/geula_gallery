import "server-only";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { jerusalemWallClock } from "@/lib/format";
import { PATUR_CEILING } from "@/lib/vat";
import { refundDeadlines } from "@/server/cancellations/service";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  adminAlerts,
  artworks,
  cronRuns,
  orders,
  paymentAttempts,
  refunds,
  sales,
  shipments,
  taxDocuments,
} from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  GOLIVE_BLOCKERS,
  type GoLiveBlocker,
  goLiveBlockers,
} from "@/server/golive";
import { countOpenRequests } from "@/server/requests/service";
import { getSetting } from "@/server/settings";

/**
 * Dashboard read model (spec §6.10 `/admin`): needs-attention cards (including the cancellation
 * refund deadlines of `cancellations/service.ts#refundDeadlines`), the year-to-date turnover
 * against the osek-patur ceiling (mock and demo sales excluded; approximate), and the go-live
 * readiness list: WS6's authoritative blockers (`golive.ts#goLiveBlockers`) plus the operational
 * drivers that are not blockers (tax documents, email, storage).
 */
export interface AttentionItem {
  /** Order id for a link, when the item belongs to an order. */
  orderId: string | null;
  /** Cancellation id for a link (cancellation refund deadlines). */
  cancellationId?: string;
  label: string;
  /** Due date for deadline items. */
  dueAt?: Date | null;
}

export interface AttentionCard {
  key:
    | "cancellationRefunds"
    | "refundsDue"
    | "refundProblems"
    | "deferredPayments"
    | "labelUnknown"
    | "taxDocuments"
    | "toFulfil"
    | "blocked"
    | "openRequests"
    | "ratesUncalibrated"
    | "staleCron"
    | "criticalAlerts";
  severity: "critical" | "warning" | "info";
  count: number;
  items: AttentionItem[];
}

export interface DashboardData {
  cards: AttentionCard[];
  turnover: {
    year: number;
    totalIlsMinor: number;
    ceilingIlsMinor: number | null;
    salesCount: number;
  };
  goLive: GoLiveItem[];
}

export interface GoLiveItem {
  /** A `golive.ts` blocker code, or an operational item (`taxDocuments`, `email`, `storage`). */
  key: GoLiveBlocker | "taxDocuments" | "email" | "storage";
  ok: boolean;
  /** True for `golive.ts` blockers: live checkout is refused while one is missing. */
  blocker: boolean;
}

const DAY = 24 * 60 * 60_000;
const ITEMS = 5;

/** Expected cadence of each cron job (spec §5.11), with slack. */
const CRON_MAX_AGE_MS: Record<string, number> = {
  reconcile: 20 * 60_000,
  outbox: 20 * 60_000,
  tracking: 3 * 60 * 60_000,
  daily: 26 * 60 * 60_000,
  purge: 26 * 60 * 60_000,
};

export async function getDashboard(
  _ctx: AdminContext,
  deps: { db?: DbOrTx; env?: Env; now?: Date } = {},
): Promise<DashboardData> {
  const db = deps.db ?? defaultDb;
  const env = deps.env ?? defaultEnv;
  const now = deps.now ?? new Date();
  const cards: AttentionCard[] = [];

  // Cancellation refunds not settled yet, due within 5 days or overdue (spec §5.7 step 10),
  // counted from the notice: a RECEIVED notice has no refund row yet.
  const cancelDue = (await refundDeadlines(db)).filter(
    (d) =>
      !d.refundSettled && d.refundDueAt.getTime() < now.getTime() + 5 * DAY,
  );
  cards.push({
    key: "cancellationRefunds",
    severity: cancelDue.some(
      (d) => d.refundDueAt.getTime() < now.getTime() + 2 * DAY,
    )
      ? "critical"
      : "warning",
    count: cancelDue.length,
    items: cancelDue.slice(0, ITEMS).map((d) => ({
      orderId: null,
      cancellationId: d.id,
      label: d.number,
      dueAt: d.refundDueAt,
    })),
  });

  // Refunds due within 5 days or overdue (spec §5.7 step 10).
  const openRefund = and(
    inArray(refunds.status, [
      "REQUESTED",
      "IN_FLIGHT",
      "PROVIDER_PENDING",
      "UNKNOWN",
      "MANUAL_REQUIRED",
      "FAILED",
    ]),
    isNotNull(refunds.legalDueAt),
  );
  const due = await db
    .select({
      orderId: refunds.orderId,
      number: orders.number,
      dueAt: refunds.legalDueAt,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(
      and(
        openRefund,
        lt(refunds.legalDueAt, new Date(now.getTime() + 5 * DAY)),
      ),
    )
    .orderBy(asc(refunds.legalDueAt));
  cards.push({
    key: "refundsDue",
    severity: due.some(
      (d) => d.dueAt && d.dueAt.getTime() < now.getTime() + 2 * DAY,
    )
      ? "critical"
      : "warning",
    count: due.length,
    items: due
      .slice(0, ITEMS)
      .map((d) => ({ orderId: d.orderId, label: d.number, dueAt: d.dueAt })),
  });

  // NEEDS_REFUND attempts and refunds that need the admin.
  const problems = await db
    .select({
      orderId: refunds.orderId,
      number: orders.number,
      status: refunds.status,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(
      or(
        inArray(refunds.status, ["MANUAL_REQUIRED", "UNKNOWN"]),
        and(eq(refunds.status, "FAILED"), isNull(refunds.failureConfirmedAt)),
      ),
    )
    .orderBy(desc(refunds.createdAt));
  const needsRefund = await db
    .select({ orderId: paymentAttempts.orderId, number: orders.number })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(eq(paymentAttempts.status, "NEEDS_REFUND"));
  const refundItems = [
    ...problems.map((p) => ({
      orderId: p.orderId,
      label: `${p.number} · ${p.status}`,
    })),
    ...needsRefund.map((n) => ({
      orderId: n.orderId,
      label: `${n.number} · NEEDS_REFUND`,
    })),
  ];
  cards.push({
    key: "refundProblems",
    severity: "critical",
    count: refundItems.length,
    items: refundItems.slice(0, ITEMS),
  });

  // Deferred payments (another attempt of the order is being confirmed).
  const deferred = await db
    .select({ entityId: adminAlerts.entityId, params: adminAlerts.params })
    .from(adminAlerts)
    .where(
      and(
        eq(adminAlerts.kind, "PAYMENT_DEFERRED"),
        isNull(adminAlerts.acknowledgedAt),
      ),
    );
  cards.push({
    key: "deferredPayments",
    severity: "warning",
    count: deferred.length,
    items: deferred.slice(0, ITEMS).map((d) => ({
      orderId: null,
      label: String((d.params as { orderNumber?: string })?.orderNumber ?? ""),
    })),
  });

  // Labels whose outcome is unknown (claim protocol, spec §5.5).
  const labels = await db
    .select({ orderId: shipments.orderId, number: orders.number })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.status, "LABEL_UNKNOWN"));
  cards.push({
    key: "labelUnknown",
    severity: "critical",
    count: labels.length,
    items: labels
      .slice(0, ITEMS)
      .map((l) => ({ orderId: l.orderId, label: l.number })),
  });

  // Tax documents needing action.
  const docs = await db
    .select({
      orderId: taxDocuments.orderId,
      number: orders.number,
      status: taxDocuments.status,
    })
    .from(taxDocuments)
    .innerJoin(orders, eq(orders.id, taxDocuments.orderId))
    .where(inArray(taxDocuments.status, ["FAILED", "NEEDS_MANUAL", "UNKNOWN"]))
    .orderBy(desc(taxDocuments.createdAt));
  cards.push({
    key: "taxDocuments",
    severity: "warning",
    count: docs.length,
    items: docs.slice(0, ITEMS).map((d) => ({
      orderId: d.orderId,
      label: `${d.number} · ${d.status}`,
    })),
  });

  // Orders to fulfil (paid, not blocked, shipment not yet handed over).
  const toFulfil = await db
    .select({
      orderId: orders.id,
      number: orders.number,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .innerJoin(shipments, eq(shipments.orderId, orders.id))
    .where(
      and(
        eq(orders.status, "PAID"),
        isNull(orders.fulfillmentBlockedReason),
        inArray(shipments.status, [
          "AWAITING_FULFILLMENT",
          "PACKED",
          "READY_FOR_PICKUP",
        ]),
      ),
    )
    .orderBy(asc(orders.paidAt));
  cards.push({
    key: "toFulfil",
    severity: "info",
    count: toFulfil.length,
    items: toFulfil
      .slice(0, ITEMS)
      .map((o) => ({ orderId: o.orderId, label: o.number })),
  });

  // Fulfillment blocks (pending cancellation, review, dispute, reversal).
  const blocked = await db
    .select({
      orderId: orders.id,
      number: orders.number,
      reason: orders.fulfillmentBlockedReason,
    })
    .from(orders)
    .where(
      and(
        isNotNull(orders.fulfillmentBlockedReason),
        inArray(orders.status, ["PAID", "PAYMENT_REVIEW", "COMPLETED"]),
      ),
    );
  cards.push({
    key: "blocked",
    severity: "warning",
    count: blocked.length,
    items: blocked.slice(0, ITEMS).map((b) => ({
      orderId: b.orderId,
      label: `${b.number} · ${b.reason}`,
    })),
  });

  const openRequests = await countOpenRequests(db);
  cards.push({
    key: "openRequests",
    severity: "info",
    count: openRequests,
    items: [],
  });

  const shipping = await getSetting("shipping", db);
  const calibratedAt = shipping.calibratedAt
    ? new Date(shipping.calibratedAt)
    : null;
  const uncalibrated =
    !calibratedAt || now.getTime() - calibratedAt.getTime() > 90 * DAY;
  cards.push({
    key: "ratesUncalibrated",
    severity: "warning",
    count: uncalibrated ? 1 : 0,
    items: [],
  });

  // Stale cron: the latest successful run of each job.
  const runs = await db
    .select({
      job: cronRuns.job,
      last: sql<Date | null>`max(${cronRuns.startedAt}) FILTER (WHERE ${cronRuns.ok})`,
    })
    .from(cronRuns)
    .groupBy(cronRuns.job);
  const stale = Object.entries(CRON_MAX_AGE_MS).filter(([job, maxAge]) => {
    const last = runs.find((r) => r.job === job)?.last;
    return !last || now.getTime() - new Date(last).getTime() > maxAge;
  });
  cards.push({
    key: "staleCron",
    severity: "info",
    count: stale.length,
    items: stale.map(([job]) => ({ orderId: null, label: job })),
  });

  const critical = await db
    .select({
      id: adminAlerts.id,
      kind: adminAlerts.kind,
      entity: adminAlerts.entity,
      entityId: adminAlerts.entityId,
    })
    .from(adminAlerts)
    .where(
      and(
        eq(adminAlerts.severity, "CRITICAL"),
        isNull(adminAlerts.acknowledgedAt),
      ),
    )
    .orderBy(desc(adminAlerts.createdAt));
  cards.push({
    key: "criticalAlerts",
    severity: "critical",
    count: critical.length,
    items: critical.slice(0, ITEMS).map((a) => ({
      orderId: a.entity === "order" ? a.entityId : null,
      label: a.kind,
    })),
  });

  return {
    cards,
    turnover: await turnover(db, now),
    goLive: await goLive(db, env),
  };
}

/**
 * Year-to-date turnover (Asia/Jerusalem calendar year): live sales, excluding mock sales and demo
 * works. USD sales use the order's reference FX (or the settings FX for offline USD sales).
 * Approximate by design (spec §6.10): the accountant's figure is the legal one.
 */
async function turnover(db: DbOrTx, now: Date) {
  const year = jerusalemWallClock(now).year;
  const start = new Date(`${year}-01-01T00:00:00+02:00`);
  const rows = await db
    .select({
      priceMinor: sales.priceMinor,
      currency: sales.currency,
      fx: orders.fxIlsPerUnit,
    })
    .from(sales)
    .innerJoin(artworks, eq(artworks.id, sales.artworkId))
    .leftJoin(orders, eq(orders.id, sales.orderId))
    .where(
      and(
        isNull(sales.voidedAt),
        eq(sales.isMock, false),
        eq(artworks.isDemo, false),
        gte(sales.soldAt, start),
      ),
    );
  const checkout = await getSetting("checkout", db);
  let total = 0;
  for (const r of rows) {
    total +=
      r.currency === "ILS"
        ? r.priceMinor
        : Math.round(
            r.priceMinor * (r.fx ? Number(r.fx) : checkout.fx.ilsPerUsd),
          );
  }
  return {
    year,
    totalIlsMinor: total,
    ceilingIlsMinor: PATUR_CEILING[year] ?? null,
    salesCount: rows.length,
  };
}

async function goLive(db: DbOrTx, env: Env): Promise<GoLiveItem[]> {
  const report = await goLiveBlockers({ db, env });
  return [
    ...GOLIVE_BLOCKERS.map((key) => ({
      key,
      ok: !report.blockers.includes(key),
      blocker: true,
    })),
    {
      key: "taxDocuments" as const,
      ok:
        env.TAX_DOCUMENTS_MODE === "morning" ||
        env.TAX_DOCUMENTS_MODE === "gateway",
      blocker: false,
    },
    {
      key: "email" as const,
      ok: env.EMAIL_DRIVER === "resend",
      blocker: false,
    },
    {
      key: "storage" as const,
      ok: env.STORAGE_DRIVER === "blob",
      blocker: false,
    },
  ];
}

/** Badge counts for the admin navigation (spec §6.10 "bottom tabs … with badges"). */
export async function navBadges(
  _ctx: AdminContext,
  db: DbOrTx = defaultDb,
): Promise<{ inbox: number; orders: number; alerts: number }> {
  const [toFulfil] = await db
    .select({ n: count() })
    .from(orders)
    .innerJoin(shipments, eq(shipments.orderId, orders.id))
    .where(
      and(
        eq(orders.status, "PAID"),
        inArray(shipments.status, [
          "AWAITING_FULFILLMENT",
          "PACKED",
          "READY_FOR_PICKUP",
        ]),
      ),
    );
  const [alerts] = await db
    .select({ n: count() })
    .from(adminAlerts)
    .where(isNull(adminAlerts.acknowledgedAt));
  return {
    inbox: await countOpenRequests(db),
    orders: toFulfil?.n ?? 0,
    alerts: alerts?.n ?? 0,
  };
}
