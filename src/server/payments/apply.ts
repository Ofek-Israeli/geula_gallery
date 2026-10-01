import "server-only";
import type { Tx } from "@/server/db/client";
import { notImplemented } from "@/server/domain/errors";
import type { VerifiedPayment } from "./types";

/**
 * `applySuccessfulPayment()` (spec §5.2; frozen contract): inside the finalize transaction, with
 * artworks → order → attempt locked in the global order, checks sellability and quote binding
 * (`attempt.quote_version = order.quote_version AND amount AND currency`), then either records the
 * sale (attempt SUCCEEDED, order PAID, artworks SOLD, `sales` ONLINE, outbox jobs) or marks the
 * attempt NEEDS_REFUND with the reason and requests the refund. Body: M2 commerce lead.
 */
export type ApplyOutcome =
  | { kind: "applied"; orderId: string; saleIds: string[] }
  | {
      kind: "needs_refund";
      reason:
        | "LOST_RESERVATION"
        | "DUPLICATE_PAYMENT"
        | "ORDER_CANCELLED"
        | "STALE_QUOTE"
        | "AMOUNT_MISMATCH";
      refundId: string | null;
    }
  | { kind: "already_applied" };

export async function applySuccessfulPayment(
  _tx: Tx,
  _input: { attemptId: string; verified: VerifiedPayment; actor: string },
): Promise<ApplyOutcome> {
  return notImplemented("applySuccessfulPayment", "M2");
}
