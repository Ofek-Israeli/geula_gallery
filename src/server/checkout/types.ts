import "server-only";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import type { PostalAddress } from "@/lib/validation/address";
import type { ProviderId, Wallet } from "@/server/payments/types";
import type {
  BlockReason,
  NoticeCode,
  ShippingMethod,
  ShippingQuoteResult,
} from "@/server/shipping/types";

/** Shared checkout types (spec §5.1, §5.8; frozen with `checkout/*`). */
export interface CheckoutQuoteRequest {
  slug: string;
  locale: Locale;
  country?: string;
  method?: ShippingMethod;
  currency?: Currency;
}

export type CheckoutQuote =
  | {
      kind: "ok";
      artworkId: string;
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
      }[];
      notices: NoticeCode[];
      usdAvailable: boolean;
    }
  | {
      kind: "blocked";
      reason:
        | BlockReason
        | "NOT_AVAILABLE"
        | "RESERVED"
        | "NOT_PRICED"
        | "DEMO_LIVE_PROVIDER"
        | "NO_PROVIDER";
      artworkId: string | null;
    };

export interface BuyerDetails {
  name: string;
  email: string;
  phone: string;
  companyName?: string;
  vatId?: string;
}

export interface StartCheckoutInput {
  slug: string;
  locale: Locale;
  country: string;
  method: ShippingMethod;
  currency: Currency;
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
    ageConfirmed: true;
    dutiesNoticeVersion?: string;
    receiptEmailConsent: boolean;
  };
  ipHash: string | null;
}

export type StartCheckoutResult =
  | {
      kind: "redirect";
      orderId: string;
      orderNumber: string;
      accessToken: string;
      url: string;
    }
  | { kind: "price_changed"; quote: CheckoutQuote }
  | { kind: "just_reserved" }
  /**
   * A guard refused the start: a blocked quote reason, `provider_unavailable`, a hold refusal
   * (`too_many_holds`, `artwork_hold_budget`, `hold_cooldown`), `go_live_blocked`.
   */
  | { kind: "refused"; code: string }
  /** The provider call failed; the hold is kept and the order page offers a retry. */
  | {
      kind: "provider_error";
      orderId: string;
      orderNumber: string;
      accessToken: string;
    };
