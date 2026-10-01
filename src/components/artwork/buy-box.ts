/**
 * Pure decisions behind `LiveBuyBox` and `StickyBuyBar` (spec §6.3), unit-tested in
 * `tests/unit/storefront-buy-box.test.ts`.
 */
import type { ArtworkDetailDTO, ZoneEstimateDTO } from "@/lib/catalog";
import type { RequestKind } from "@/lib/routes";

export type TrustItem = "tracked" | "insured" | "cancellation" | "coa";

/**
 * The trust row: "tracked · 14-day cancellation · COA", plus "insured" only when the cheapest
 * Israeli quote actually includes insurance (spec §1.2, §6.3; never a claim the quote does not
 * back).
 */
export function trustItems(
  estimates: readonly ZoneEstimateDTO[],
  coaIncluded: boolean,
): TrustItem[] {
  const israel = estimates.find((e) => e.zone === "IL");
  const insured = israel?.kind === "price" && israel.insured;
  return [
    "tracked",
    ...(insured ? (["insured"] as const) : []),
    "cancellation",
    ...(coaIncluded ? (["coa"] as const) : []),
  ];
}

/** True when a zone's "from" price includes insurance (shown next to that zone only). */
export function zoneIsInsured(e: ZoneEstimateDTO): boolean {
  return e.kind === "price" && e.insured;
}

/** The ILS price is shown for available works and works in another buyer's checkout hold. */
export function shownPriceMinor(
  a: Pick<ArtworkDetailDTO, "state" | "price">,
): number | null {
  if (a.state.kind !== "available" && a.state.kind !== "reserved") return null;
  if (a.price.onRequest) return null;
  return a.price.ilsMinor;
}

export type PrimaryAction =
  | { kind: "buy" }
  | {
      kind: "request";
      request: RequestKind;
      label: "requestQuote" | "ask" | "askSimilar";
    };

/**
 * The main call to action: Buy now when buyable; "Request a quote" for quote-only works;
 * "Ask about similar works" when sold; otherwise "Ask about this work".
 */
export function primaryAction(
  a: Pick<ArtworkDetailDTO, "state" | "quoteOnly">,
): PrimaryAction {
  if (a.state.kind === "available" && a.state.buyable) return { kind: "buy" };
  if (a.state.kind === "available" && a.quoteOnly) {
    return { kind: "request", request: "quote", label: "requestQuote" };
  }
  if (a.state.kind === "sold") {
    return { kind: "request", request: "question", label: "askSimilar" };
  }
  return { kind: "request", request: "question", label: "ask" };
}
