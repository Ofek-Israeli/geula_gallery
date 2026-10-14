import "server-only";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import type { PostalAddress } from "@/lib/validation/address";
import type { ProviderId, Wallet } from "@/server/payments/types";
import type {
  BlockReason,
  NoticeCode,
  Packing,
  ShippingMethod,
  ShippingQuoteResult,
} from "@/server/shipping/types";

/**
 * Shared checkout types (spec §5.1, §5.8). A checkout covers one work (`slug`, "Buy now") or the
 * works of a cart (`artworkIds`, in cart order); both go through the same N-item core.
 */
interface QuoteRequestBase {
  locale: Locale;
  country?: string;
  method?: ShippingMethod;
  currency?: Currency;
  /** The buyer's packing choice; "ROLLED" only matters when a work is `rollableAtCheckout`. */
  packing?: Packing;
}
export type CheckoutQuoteRequest =
  | (QuoteRequestBase & { slug: string; artworkIds?: undefined })
  | (QuoteRequestBase & { artworkIds: readonly string[]; slug?: undefined });

/** One quoted work, in the quote currency (request order). */
export interface CheckoutQuoteItem {
  artworkId: string;
  slug: string;
  priceMinor: number;
}

/** Why one work of a cart cannot be checked out (the cart page names it and offers "Remove"). */
export type ItemProblemReason =
  | "NOT_AVAILABLE"
  | "RESERVED"
  | "NOT_PRICED"
  | "QUOTE_ONLY"
  | "NOT_INTERNATIONAL"
  | "SIZE_QUOTE"
  | "VALUE_CAP"
  | "MIXED_DEMO";
export interface ItemProblem {
  artworkId: string;
  reason: ItemProblemReason;
}

export type QuoteBlockReason =
  | BlockReason
  | "NOT_AVAILABLE"
  | "RESERVED"
  | "NOT_PRICED"
  | "DEMO_LIVE_PROVIDER"
  | "NO_PROVIDER"
  /** A cart mixing demo works with real works (never one order; spec §1.1 demo rules). */
  | "MIXED_DEMO"
  /** More works than `checkout.maxCartItems`. */
  | "TOO_MANY_ITEMS"
  /** Online purchase is switched off (`SALES_OPEN=false`, a showcase site): ask instead. */
  | "SALES_CLOSED";

export type CheckoutQuote =
  | {
      kind: "ok";
      /** The first work (single-item callers); `items` lists every work. */
      artworkId: string;
      items: CheckoutQuoteItem[];
      country: string;
      currency: Currency;
      itemsTotalMinor: number;
      shipping: ShippingQuoteResult;
      /** Other methods available for this destination (radios). */
      methods: ShippingQuoteResult[];
      totalMinor: number;
      vatMinor: number;
      vatRateBp: number;
      /** Offered providers; the UI builds labels from the id and capabilities. */
      providers: {
        id: ProviderId;
        label: string;
        wallets: Wallet[];
        installments: boolean;
        /** A TEST-mode provider: payments are verified but nothing is charged (labelled so). */
        test: boolean;
      }[];
      notices: NoticeCode[];
      usdAvailable: boolean;
      /** Whether any work can be rolled in a tube at the buyer's choice (the packing choice). */
      rollable: boolean;
      /** The packing the prices are for ("ROLLED" only when `rollable`). */
      packing: Packing;
    }
  | {
      kind: "blocked";
      reason: QuoteBlockReason;
      /** The first culprit work; null for an unknown slug or an empty cart. */
      artworkId: string | null;
      /** Per-work causes ([] = the cart or destination as a whole). */
      problems: ItemProblem[];
    };

export interface BuyerDetails {
  name: string;
  email: string;
  phone: string;
  companyName?: string;
  vatId?: string;
}

interface StartCheckoutBase {
  locale: Locale;
  country: string;
  method: ShippingMethod;
  currency: Currency;
  /** The packing the buyer chose (absent: as listed). */
  packing?: Packing;
  providerId: ProviderId;
  buyer: BuyerDetails;
  shipTo: PostalAddress | null;
  /** The total the buyer saw; a different server total ⇒ `price_changed`. */
  expectedTotalMinor: number;
  /** Double-submit guard (`orders.client_request_id`). */
  clientRequestId: string;
  consents: {
    termsVersion: string;
    returnsVersion: string;
    privacyVersion: string;
    dutiesNoticeVersion?: string;
    receiptEmailConsent: boolean;
  };
  ipHash: string | null;
}
export type StartCheckoutInput =
  | (StartCheckoutBase & { slug: string; items?: undefined })
  | (StartCheckoutBase & {
      /** Cart works in cart order, each with the price the buyer saw (quote currency). */
      items: { artworkId: string; expectedPriceMinor: number }[];
      slug?: undefined;
    });

export type StartCheckoutResult =
  | {
      kind: "redirect";
      orderId: string;
      orderNumber: string;
      accessToken: string;
      url: string;
      /**
       * True for our own pay page (hosted fields): it must be opened with a full page load, which
       * carries its own CSP; a client-router navigation would keep the previous page's.
       */
      fullPageLoad: boolean;
      /** The order's works (the cart action removes them from the cart). */
      artworkIds: string[];
    }
  | { kind: "price_changed"; quote: CheckoutQuote }
  /** `artworkIds`: the works someone else reserved or bought meanwhile. */
  | { kind: "just_reserved"; artworkIds: string[] }
  /**
   * A guard refused the start: a blocked quote reason, `provider_unavailable`, a hold refusal
   * (`too_many_holds`, `artwork_hold_budget`, `hold_cooldown`), `go_live_blocked`.
   */
  | { kind: "refused"; code: string; artworkIds?: string[] }
  /** The provider call failed; the hold is kept and the order page offers a retry. */
  | {
      kind: "provider_error";
      orderId: string;
      orderNumber: string;
      accessToken: string;
      artworkIds: string[];
    };
