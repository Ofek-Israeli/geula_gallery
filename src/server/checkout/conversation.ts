import "server-only";
import { and, desc, gt, sql } from "drizzle-orm";
import type { DbOrTx } from "@/server/db/client";
import { buyerRequests } from "@/server/db/schema";

/**
 * Conversation detection (spec §5.1 step 5; frozen contract): a `buyer_requests` row with the same
 * lowercased email within `conversationLookbackDays` ⇒ `conversation_took_place=true`,
 * `conversation_source='REQUEST:<id>'` (the conservative, buyer-favourable default: it can only
 * lengthen the cancellation window). The most recent request is the source.
 */
export interface ConversationResult {
  tookPlace: boolean;
  /** `REQUEST:<id>` | `LINK` | `ADMIN` | null */
  source: string | null;
}

export async function detectConversation(
  db: DbOrTx,
  input: { email: string; lookbackDays: number; now: Date },
): Promise<ConversationResult> {
  const since = new Date(
    input.now.getTime() - input.lookbackDays * 24 * 60 * 60 * 1000,
  );
  const [row] = await db
    .select({ id: buyerRequests.id })
    .from(buyerRequests)
    .where(
      and(
        sql`lower(${buyerRequests.email}) = ${input.email.trim().toLowerCase()}`,
        gt(buyerRequests.createdAt, since),
      ),
    )
    .orderBy(desc(buyerRequests.createdAt))
    .limit(1);
  return row
    ? { tookPlace: true, source: `REQUEST:${row.id}` }
    : { tookPlace: false, source: null };
}
