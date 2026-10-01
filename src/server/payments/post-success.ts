import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Currency } from "@/lib/money";
import { raiseAlert } from "@/server/alerts/service";
import { audit } from "@/server/audit";
import { type Db, db as defaultDb } from "@/server/db/client";
import { refunds, shipments } from "@/server/db/schema";
import { withTx } from "@/server/db/tx";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { lockChain, markRefundSucceeded } from "./refunds";

/**
 * `syncPostSuccessEvent` (spec §5.2; PayPal REFUNDED / REVERSED / dispute webhooks). Lock order →
 * attempt → refunds, then **match first** so our own refund is never double-counted:
 * 1. by `refunds.id = resource.custom_id`;
 * 2. by `provider_refund_id`;
 * 3. one of our IN_FLIGHT / UNKNOWN / PROVIDER_PENDING rows for the same capture and amount.
 * A match gets `provider_refund_id` and, when completed, SUCCEEDED (+ REFUND_SETTLED). Only an
 * unmatched refund is inserted as EXTERNAL SUCCEEDED. Reversals and disputes raise alerts and
 * block fulfillment of an unshipped order. Errors propagate (the webhook answers 500).
 */
export type PostSuccessEvent =
  | {
      kind: "refund";
      attemptId: string;
      refundCustomId?: string;
      providerRefundId?: string;
      amountMinor: number;
      currency: Currency;
      completed: boolean;
    }
  | { kind: "reversal" | "dispute"; attemptId: string };

export async function syncPostSuccessEvent(
  event: PostSuccessEvent,
  deps: { db?: Db } = {},
): Promise<
  ServiceResult<{ outcome: "matched" | "external" | "flagged" | "ignored" }>
> {
  const outcome = await withTx(
    async (tx) => {
      const { attempt, rows } = await lockChain(tx, event.attemptId);
      const blockIfUnshipped = async (
        reason: "PAYMENT_REVERSED" | "DISPUTE" | "EXTERNAL_REFUND",
      ) => {
        const [shipment] = await tx
          .select({ status: shipments.status })
          .from(shipments)
          .where(eq(shipments.orderId, attempt.orderId));
        if (
          !shipment ||
          shipment.status === "AWAITING_FULFILLMENT" ||
          shipment.status === "PACKED"
        ) {
          await tx.execute(
            sql`UPDATE orders SET fulfillment_blocked_reason = ${reason}, updated_at = now() WHERE id = ${attempt.orderId} AND status IN ('PAID', 'PAYMENT_REVIEW')`,
          );
        }
      };

      if (event.kind !== "refund") {
        await raiseAlert(
          {
            severity: "CRITICAL",
            kind:
              event.kind === "reversal"
                ? "PAYMENT_REVERSED"
                : "PAYMENT_DISPUTE",
            dedupeKey: `${event.kind}:${attempt.id}`,
            entity: "payment_attempt",
            entityId: attempt.id,
          },
          tx,
        );
        await blockIfUnshipped(
          event.kind === "reversal" ? "PAYMENT_REVERSED" : "DISPUTE",
        );
        return "flagged" as const;
      }

      const open = new Set(["IN_FLIGHT", "UNKNOWN", "PROVIDER_PENDING"]);
      const match =
        rows.find(
          (r) => event.refundCustomId && r.id === event.refundCustomId,
        ) ??
        rows.find(
          (r) =>
            event.providerRefundId &&
            r.providerRefundId === event.providerRefundId,
        ) ??
        rows.find(
          (r) => open.has(r.status) && r.amountMinor === event.amountMinor,
        );
      if (match) {
        if (event.providerRefundId && !match.providerRefundId) {
          await tx
            .update(refunds)
            .set({ providerRefundId: event.providerRefundId })
            .where(eq(refunds.id, match.id));
        }
        if (event.completed && open.has(match.status)) {
          await markRefundSucceeded(tx, match, event.providerRefundId ?? null);
        }
        return "matched" as const;
      }
      if (!event.completed) return "ignored" as const;
      const [row] = await tx
        .insert(refunds)
        .values({
          attemptId: attempt.id,
          orderId: attempt.orderId,
          amountMinor: event.amountMinor,
          currency: event.currency,
          reason: "EXTERNAL",
          status: "SUCCEEDED",
          idemKey: randomUUID(),
          providerRefundId: event.providerRefundId ?? null,
          requestedBy: `provider:${attempt.provider.toLowerCase()}`,
          completedAt: new Date(),
        })
        .returning({ id: refunds.id });
      await raiseAlert(
        {
          severity: "WARNING",
          kind: "EXTERNAL_REFUND",
          dedupeKey: `external-refund:${row?.id ?? attempt.id}`,
          entity: "payment_attempt",
          entityId: attempt.id,
          params: { amountMinor: event.amountMinor },
        },
        tx,
      );
      await blockIfUnshipped("EXTERNAL_REFUND");
      await audit(
        {
          actor: "system",
          action: "refund.external_recorded",
          entity: "refund",
          entityId: row?.id ?? null,
          after: { attemptId: attempt.id, amountMinor: event.amountMinor },
        },
        tx,
      );
      return "external" as const;
    },
    { db: deps.db ?? defaultDb, name: "payments.post_success" },
  );
  return withEffects({ outcome }, { outbox: true });
}
