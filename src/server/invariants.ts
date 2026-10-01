import "server-only";
import { sql } from "drizzle-orm";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";

/**
 * `checkInvariants()` (spec §3.4 layer 6, run daily; Tier B). Read-only SQL over the whole
 * database. Each check returns the ids that violate it; the daily job raises one CRITICAL
 * `INVARIANT_VIOLATION` alert per (check, id).
 *
 * 1. `sold_has_one_sale`: SOLD ⇔ exactly one active (unvoided) sale.
 * 2. `hold_belongs_to_open_order`: every live hold belongs to an AWAITING_PAYMENT or PAYMENT_REVIEW
 *    order.
 * 3. `paid_order_one_succeeded_attempt`: every PAID/COMPLETED order has exactly one SUCCEEDED
 *    attempt, it is `paid_attempt_id`, and it is bound to the order's quote version, total and
 *    currency.
 * 4. `refunds_within_capture`: Σ refunds (all rows except confirmed FAILED) ≤ the captured amount.
 * 5. `captured_attempt_has_receipt`: every SUCCEEDED attempt finalized more than `graceMinutes`
 *    ago has a receipt row (a document provider may still be retrying: any status counts).
 * 6. `settled_refund_has_credit_note`: every settled refund (SUCCEEDED/MANUAL_DONE, not EXTERNAL)
 *    of an attempt that has a receipt row, completed more than `graceMinutes` ago, has a
 *    credit-note row.
 */
export const INVARIANT_CHECKS = [
  "sold_has_one_sale",
  "hold_belongs_to_open_order",
  "paid_order_one_succeeded_attempt",
  "refunds_within_capture",
  "captured_attempt_has_receipt",
  "settled_refund_has_credit_note",
] as const;
export type InvariantCheck = (typeof INVARIANT_CHECKS)[number];

export interface InvariantViolation {
  check: InvariantCheck;
  entity: "artwork" | "order" | "payment_attempt" | "refund";
  id: string;
}

export interface InvariantReport {
  ok: boolean;
  violations: InvariantViolation[];
  checkedAt: string;
}

async function ids(db: DbOrTx, query: ReturnType<typeof sql>) {
  const res = await db.execute<{ id: string }>(query);
  return res.rows.map((r) => r.id);
}

export async function checkInvariants(
  opts: { db?: DbOrTx; graceMinutes?: number } = {},
): Promise<InvariantReport> {
  const db = opts.db ?? defaultDb;
  const grace = sql`make_interval(mins => ${opts.graceMinutes ?? 60})`;
  const out: InvariantViolation[] = [];
  const push = (
    check: InvariantCheck,
    entity: InvariantViolation["entity"],
    list: string[],
  ) => {
    for (const id of list) out.push({ check, entity, id });
  };

  push(
    "sold_has_one_sale",
    "artwork",
    await ids(
      db,
      sql`SELECT a.id FROM artworks a
            LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM sales s
                                WHERE s.artwork_id = a.id AND s.voided_at IS NULL) s ON true
           WHERE (a.sale_status = 'SOLD') <> (s.n = 1) OR s.n > 1`,
    ),
  );

  push(
    "hold_belongs_to_open_order",
    "artwork",
    await ids(
      db,
      sql`SELECT a.id FROM artworks a JOIN orders o ON o.id = a.reserved_by_order_id
           WHERE a.reserved_until > now()
             AND o.status NOT IN ('AWAITING_PAYMENT', 'PAYMENT_REVIEW')`,
    ),
  );

  push(
    "paid_order_one_succeeded_attempt",
    "order",
    await ids(
      db,
      sql`SELECT o.id FROM orders o
           WHERE o.status IN ('PAID', 'COMPLETED')
             AND (
               (SELECT count(*) FROM payment_attempts pa
                 WHERE pa.order_id = o.id AND pa.status = 'SUCCEEDED') <> 1
               OR NOT EXISTS (
                 SELECT 1 FROM payment_attempts pa
                  WHERE pa.id = o.paid_attempt_id AND pa.status = 'SUCCEEDED'
                    AND pa.quote_version = o.quote_version
                    AND pa.amount_minor = o.total_minor
                    AND pa.currency = o.currency))`,
    ),
  );

  push(
    "refunds_within_capture",
    "payment_attempt",
    await ids(
      db,
      sql`SELECT pa.id FROM payment_attempts pa
            JOIN refunds r ON r.attempt_id = pa.id
           WHERE NOT (r.status = 'FAILED' AND r.failure_confirmed_at IS NOT NULL)
           GROUP BY pa.id, pa.amount_minor
          HAVING sum(r.amount_minor) > pa.amount_minor`,
    ),
  );

  push(
    "captured_attempt_has_receipt",
    "payment_attempt",
    await ids(
      db,
      sql`SELECT pa.id FROM payment_attempts pa
           WHERE pa.status = 'SUCCEEDED'
             AND coalesce(pa.finalized_at, pa.updated_at) < now() - ${grace}
             AND NOT EXISTS (
               SELECT 1 FROM tax_documents t
                WHERE t.attempt_id = pa.id AND t.kind IN ('RECEIPT', 'INVOICE_RECEIPT'))`,
    ),
  );

  push(
    "settled_refund_has_credit_note",
    "refund",
    await ids(
      db,
      sql`SELECT r.id FROM refunds r
           WHERE r.status IN ('SUCCEEDED', 'MANUAL_DONE') AND r.reason <> 'EXTERNAL'
             AND coalesce(r.completed_at, r.updated_at) < now() - ${grace}
             AND EXISTS (SELECT 1 FROM tax_documents t
                          WHERE t.attempt_id = r.attempt_id
                            AND t.kind IN ('RECEIPT', 'INVOICE_RECEIPT'))
             AND NOT EXISTS (SELECT 1 FROM tax_documents t
                              WHERE t.refund_id = r.id AND t.kind = 'CREDIT_NOTE')`,
    ),
  );

  return {
    ok: out.length === 0,
    violations: out,
    checkedAt: new Date().toISOString(),
  };
}
