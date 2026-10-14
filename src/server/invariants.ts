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
 * 7. `paid_order_items_sold`: every item of a PAID/COMPLETED order has exactly one sale row
 *    (voided rows included: a cancellation voids, never deletes), and the sales add up to the
 *    order's items total (a cart order sells all of its works or none).
 * 8. `cancellation_items_match_amounts`: an accepted cancellation's `items_minor` is the sum of the
 *    prices of the works it covers.
 * 9. `active_item_has_sale`: every work of a PAID/COMPLETED order that no cancellation covers has
 *    an unvoided sale (only a cancelled work is ever relisted).
 * 10. `cancellation_void_has_item`: a sale voided by a cancellation belongs to a work that
 *    cancellation covers.
 * 11. `order_cancellation_state`: an order CANCELLED by the buyer has every work cancelled.
 * 12. `test_payment_never_sells_real_work`: no unvoided sale of a real (non-demo) order comes from
 *    a TEST-mode payment (the checkout preview closes those payments without selling).
 */
export const INVARIANT_CHECKS = [
  "sold_has_one_sale",
  "hold_belongs_to_open_order",
  "paid_order_one_succeeded_attempt",
  "refunds_within_capture",
  "captured_attempt_has_receipt",
  "settled_refund_has_credit_note",
  "paid_order_items_sold",
  "cancellation_items_match_amounts",
  "active_item_has_sale",
  "cancellation_void_has_item",
  "order_cancellation_state",
  "test_payment_never_sells_real_work",
] as const;
export type InvariantCheck = (typeof INVARIANT_CHECKS)[number];

export interface InvariantViolation {
  check: InvariantCheck;
  entity:
    | "artwork"
    | "order"
    | "payment_attempt"
    | "refund"
    | "cancellation"
    | "sale";
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

  push(
    "paid_order_items_sold",
    "order",
    await ids(
      db,
      sql`SELECT o.id FROM orders o
           WHERE o.status IN ('PAID', 'COMPLETED')
             AND (
               EXISTS (SELECT 1 FROM order_items oi
                        WHERE oi.order_id = o.id
                          AND (SELECT count(*) FROM sales s WHERE s.order_item_id = oi.id) <> 1)
               OR (SELECT coalesce(sum(s.price_minor), 0) FROM sales s
                     JOIN order_items oi ON oi.id = s.order_item_id
                    WHERE oi.order_id = o.id) <> o.items_total_minor)`,
    ),
  );

  push(
    "cancellation_items_match_amounts",
    "cancellation",
    await ids(
      db,
      sql`SELECT c.id FROM cancellations c
           WHERE c.status IN ('ACCEPTED', 'CLOSED') AND c.items_minor IS NOT NULL
             AND c.items_minor <> (SELECT coalesce(sum(oi.price_minor), 0)
                                     FROM cancellation_items ci
                                     JOIN order_items oi ON oi.id = ci.order_item_id
                                    WHERE ci.cancellation_id = c.id)`,
    ),
  );

  push(
    "active_item_has_sale",
    "order",
    await ids(
      db,
      sql`SELECT DISTINCT o.id FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
           WHERE o.status IN ('PAID', 'COMPLETED')
             AND NOT EXISTS (SELECT 1 FROM cancellation_items ci WHERE ci.order_item_id = oi.id)
             AND NOT EXISTS (SELECT 1 FROM sales s
                              WHERE s.order_item_id = oi.id AND s.voided_at IS NULL)`,
    ),
  );

  push(
    "cancellation_void_has_item",
    "sale",
    await ids(
      db,
      sql`SELECT s.id FROM sales s
           WHERE s.void_reason LIKE 'CANCELLATION:%'
             AND NOT EXISTS (
               SELECT 1 FROM cancellation_items ci
                 JOIN cancellations c ON c.id = ci.cancellation_id
                WHERE ci.order_item_id = s.order_item_id
                  AND s.void_reason = 'CANCELLATION:' || c.number)`,
    ),
  );

  push(
    "order_cancellation_state",
    "order",
    await ids(
      db,
      sql`SELECT o.id FROM orders o
           WHERE o.status = 'CANCELLED' AND o.status_reason = 'BUYER_CANCELLATION'
             AND EXISTS (SELECT 1 FROM order_items oi
                          WHERE oi.order_id = o.id
                            AND NOT EXISTS (SELECT 1 FROM cancellation_items ci
                                             WHERE ci.order_item_id = oi.id))`,
    ),
  );

  push(
    "test_payment_never_sells_real_work",
    "sale",
    await ids(
      db,
      sql`SELECT s.id FROM sales s
            JOIN orders o ON o.id = s.order_id
            JOIN payment_attempts pa ON pa.id = o.paid_attempt_id
           WHERE s.voided_at IS NULL AND NOT o.is_demo AND pa.provider_mode = 'TEST'`,
    ),
  );

  return {
    ok: out.length === 0,
    violations: out,
    checkedAt: new Date().toISOString(),
  };
}
