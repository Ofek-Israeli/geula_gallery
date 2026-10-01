import "server-only";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/server/db/client";
import type { CronJob } from "./index";

/**
 * `purge` cron job, `30 2 * * *` UTC (spec §7 Retention; the periods are for the lawyer and the
 * accountant to confirm). Owner: WS6. Idempotent bulk statements; each step is skipped once the
 * budget is spent. Returns the affected row counts.
 *
 * | Data | Rule |
 * |---|---|
 * | never-paid EXPIRED orders | buyer and address fields anonymised 30 days after the last update |
 * | paid orders | anonymised 7 years after they were placed |
 * | cancellations matched to no order | deleted after 2 years (unless another notice links to them) |
 * | `email_messages.html` / `text` | cleared after 30 days |
 * | `payment_events.payload_redacted` | cleared after 180 days |
 * | raw tracking data | cleared 30 days after delivery |
 * | `rate_limits` | deleted after 2 days |
 * | `mock_payments` | deleted after 30 days once the attempt is final |
 * | closed buyer requests with no order | deleted after 24 months |
 */
export const PURGE_STEPS = [
  "expiredOrders",
  "oldPaidOrders",
  "unmatchedCancellations",
  "emailBodies",
  "paymentEventPayloads",
  "trackingRaw",
  "rateLimits",
  "mockPayments",
  "closedRequests",
] as const;

const ANONYMIZE = sql`
  buyer_name = NULL, buyer_email = NULL, buyer_phone = NULL, buyer_company_name = NULL,
  buyer_vat_id = NULL, ship_name = NULL, ship_line1 = NULL, ship_line2 = NULL, ship_city = NULL,
  ship_region = NULL, ship_postal_code = NULL, ship_phone = NULL, client_ip_hash = NULL,
  admin_notes = NULL, access_version = access_version + 1,
  anonymized_at = now(), updated_at = now()`;

export function purgeStatements(): Record<
  (typeof PURGE_STEPS)[number],
  ReturnType<typeof sql>
> {
  return {
    expiredOrders: sql`UPDATE orders SET ${ANONYMIZE}
      WHERE status = 'EXPIRED' AND paid_attempt_id IS NULL AND anonymized_at IS NULL
        AND updated_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = orders.id
                         AND pa.status IN ('SUCCEEDED', 'NEEDS_REFUND', 'REFUNDED',
                                           'CAPTURING', 'PAYMENT_REVIEW'))`,
    oldPaidOrders: sql`UPDATE orders SET ${ANONYMIZE}
      WHERE paid_attempt_id IS NOT NULL AND anonymized_at IS NULL
        AND created_at < now() - interval '7 years'`,
    unmatchedCancellations: sql`DELETE FROM cancellations c
      WHERE c.order_id IS NULL AND c.refund_id IS NULL
        AND c.received_at < now() - interval '2 years'
        AND NOT EXISTS (SELECT 1 FROM cancellations d WHERE d.duplicate_of_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.cancellation_id = c.id)`,
    emailBodies: sql`UPDATE email_messages SET html = NULL, text = NULL, updated_at = now()
      WHERE (html IS NOT NULL OR text IS NOT NULL) AND created_at < now() - interval '30 days'`,
    paymentEventPayloads: sql`UPDATE payment_events SET payload_redacted = NULL, updated_at = now()
      WHERE payload_redacted IS NOT NULL AND received_at < now() - interval '180 days'`,
    trackingRaw: sql`UPDATE shipment_events e SET raw = NULL
      FROM shipments s
      WHERE s.id = e.shipment_id AND e.raw IS NOT NULL
        AND s.delivered_at < now() - interval '30 days'`,
    rateLimits: sql`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`,
    mockPayments: sql`DELETE FROM mock_payments m
      USING payment_attempts pa
      WHERE pa.id = m.attempt_id AND m.created_at < now() - interval '30 days'
        AND pa.status IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED', 'EXPIRED')`,
    closedRequests: sql`DELETE FROM buyer_requests
      WHERE order_id IS NULL
        AND status IN ('CLOSED', 'DECLINED', 'AUTO_DECLINED', 'EXPIRED', 'REPLIED')
        AND updated_at < now() - interval '24 months'`,
  };
}

export async function runPurge(
  db: DbOrTx,
  expired: () => boolean = () => false,
): Promise<Record<string, number | string>> {
  const stmts = purgeStatements();
  const out: Record<string, number | string> = {};
  for (const step of PURGE_STEPS) {
    if (expired()) {
      out[step] = "skipped (budget)";
      continue;
    }
    const res = await db.execute(stmts[step]);
    out[step] = res.rowCount ?? 0;
  }
  return out;
}

export const purgeJob: CronJob = async (ctx) => runPurge(ctx.db, ctx.expired);
