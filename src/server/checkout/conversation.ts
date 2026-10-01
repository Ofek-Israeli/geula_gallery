import "server-only";
import type { DbOrTx } from "@/server/db/client";
import { notImplemented } from "@/server/domain/errors";

/**
 * Conversation detection (spec §5.1 step 5; frozen contract): a `buyer_requests` row with the same
 * lowercased email within `conversationLookbackDays` ⇒ `conversation_took_place=true`,
 * `conversation_source='REQUEST:<id>'` (the conservative, buyer-favourable default). Body: M2.
 */
export interface ConversationResult {
  tookPlace: boolean;
  /** `REQUEST:<id>` | `LINK` | `ADMIN` | null */
  source: string | null;
}

export async function detectConversation(
  _db: DbOrTx,
  _input: { email: string; lookbackDays: number; now: Date },
): Promise<ConversationResult> {
  return notImplemented("detectConversation", "M2");
}
