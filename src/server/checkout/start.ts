import "server-only";
import type { Locale } from "@/lib/locale";
import type { ServiceResult } from "@/server/domain/effects";
import { notImplemented } from "@/server/domain/errors";
import type { ProviderId } from "@/server/payments/types";
import type { StartCheckoutInput, StartCheckoutResult } from "./types";

/**
 * `startCheckout()` (spec §5.1 step 3; frozen contract): one `withTx` per §3.5 (lock artworks →
 * advisory locks and caps → order → items → reserve → takeover expiry → attempt #1), then
 * `createCheckout` outside the transaction. Body: M2.
 */
export async function startCheckout(
  _input: StartCheckoutInput,
): Promise<ServiceResult<StartCheckoutResult>> {
  return notImplemented("startCheckout", "M2");
}

/**
 * `startPaymentForOrder()` (order page "Pay", link orders): a new attempt with the current
 * `quote_version`; re-reserves an expired hold within the §3.5 budget; extends link holds to
 * `greatest(reserved_until, now()+35 min)`; refused while an attempt is in flight. Body: M2.
 */
export async function startPaymentForOrder(_input: {
  orderId: string;
  providerId: ProviderId;
  locale: Locale;
  ipHash: string | null;
}): Promise<ServiceResult<StartCheckoutResult>> {
  return notImplemented("startPaymentForOrder", "M2");
}
