import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { CheckoutQuote, CheckoutQuoteRequest } from "./types";

/** `getCheckoutQuote()` (spec §5.1 step 2; frozen contract). Body: M2. */
export async function getCheckoutQuote(
  _req: CheckoutQuoteRequest,
): Promise<CheckoutQuote> {
  return notImplemented("getCheckoutQuote", "M2");
}
