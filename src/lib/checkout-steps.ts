/**
 * The address-first checkout (spec §5.1 step 2) as one URL contract, in three steps:
 *   1. destination: the country (`to`), `city` and `zip`, enough to quote (prices depend on the
 *      country only);
 *   2. delivery: the priced options (`ship`), the packing (`pack=rolled`: the canvas rolled in a
 *      tube, when a work allows it) and, abroad, the currency (`cur=USD`);
 *   3. details: the buyer, the street address (only for a delivery; pickup buyers type none), the
 *      consents and the payment method.
 * `step` is the step the buyer *asked for*: each GET form submits the next step's name and the
 * "Change" links send `destination` / `delivery`. Without `step` the page goes as far as the data
 * allows (deep links, and the "show the updated total" link after `price_changed`). The page never
 * goes past what the data allows: an incomplete destination stays on step 1 (with errors when the
 * buyer asked to move on), a method the destination does not offer stays on step 2.
 *
 * Pure: the pages pass in the quote's methods and the countries the selector offers.
 */
import { HOME_COUNTRY } from "./countries";
import type { CheckoutQuery } from "./routes";
import {
  DESTINATION_LIMITS,
  type DestinationIssues,
  destinationIssues,
} from "./validation/destination";

/** Delivery methods a buyer can pick at checkout (QUOTED is for link orders only). */
export const CHECKOUT_METHODS = [
  "CARRIER_TABLE",
  "ISRAEL_POST",
  "LOCAL_PICKUP",
] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

export const CHECKOUT_STEPS = ["destination", "delivery", "details"] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

const ORDER: Record<CheckoutStep, number> = {
  destination: 0,
  delivery: 1,
  details: 2,
};

export function isCheckoutMethod(value: unknown): value is CheckoutMethod {
  return (
    typeof value === "string" &&
    (CHECKOUT_METHODS as readonly string[]).includes(value)
  );
}

export function isCheckoutStep(value: unknown): value is CheckoutStep {
  return (
    typeof value === "string" &&
    (CHECKOUT_STEPS as readonly string[]).includes(value)
  );
}

/** The checkout query as the page reads it. */
export interface CheckoutParams {
  /** Trimmed and upper-cased; HOME_COUNTRY when absent. Validated by `resolveCheckoutStep`. */
  country: string;
  /** Trimmed; "" when absent. */
  city: string;
  /** Trimmed; "" when absent. */
  zip: string;
  /** A method buyers can pick, else null. */
  ship: CheckoutMethod | null;
  /** Any non-empty `ship`, including junk and QUOTED. */
  shipGiven: boolean;
  cur: "USD" | null;
  /** "rolled": the buyer wants the works rolled in a tube; null: as listed (stretched). */
  pack: "rolled" | null;
  /** The step the buyer asked for, or null. */
  step: CheckoutStep | null;
}

export type CheckoutSearchParams = Record<
  string,
  string | string[] | undefined
>;

function first(value: string | string[] | undefined): string {
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

export function parseCheckoutParams(sp: CheckoutSearchParams): CheckoutParams {
  const ship = first(sp.ship);
  const step = first(sp.step);
  return {
    country: first(sp.to).toUpperCase() || HOME_COUNTRY,
    city: first(sp.city),
    zip: first(sp.zip),
    ship: isCheckoutMethod(ship) ? ship : null,
    shipGiven: ship !== "",
    cur: first(sp.cur) === "USD" ? "USD" : null,
    pack: first(sp.pack) === "rolled" ? "rolled" : null,
    step: isCheckoutStep(step) ? step : null,
  };
}

export type DeliveryProblem = "unavailable" | "missing";

export interface StepResolution {
  /** The step to render. */
  step: CheckoutStep;
  /** The furthest step the data allows. */
  reachable: CheckoutStep;
  issues: DestinationIssues;
  destinationOk: boolean;
  /**
   * Step 1 shows `issues` only when the buyer asked to move on: not on arrival (bare URL or deep
   * link) and not after "Change".
   */
  showDestinationErrors: boolean;
  /** `ship` when the destination offers it, else null: what the step links carry on. */
  offeredShip: CheckoutMethod | null;
  /** The radio checked on step 2: the requested method when offered, else the quote's choice. */
  checkedMethod: string;
  /**
   * Step 2's notice: the requested method is not offered here ("unavailable"; not when the buyer
   * explicitly asked for step 2, e.g. after switching country with a domestic method carried
   * along), or the step 2 form came without a method ("missing").
   */
  deliveryProblem: DeliveryProblem | null;
}

export function resolveCheckoutStep(
  p: CheckoutParams,
  quote: { methods: readonly string[]; selected: string },
  offeredCountries: ReadonlySet<string>,
): StepResolution {
  const issues = destinationIssues(
    { country: p.country, city: p.city, postalCode: p.zip },
    offeredCountries,
  );
  const destinationOk = Object.keys(issues).length === 0;
  const offered = p.ship !== null && quote.methods.includes(p.ship);
  const methodOk = offered && quote.selected === p.ship;
  const reachable: CheckoutStep = !destinationOk
    ? "destination"
    : !methodOk
      ? "delivery"
      : "details";
  const step =
    p.step !== null && ORDER[p.step] < ORDER[reachable] ? p.step : reachable;
  const deliveryProblem: DeliveryProblem | null =
    step !== "delivery"
      ? null
      : p.shipGiven && !offered && p.step !== "delivery"
        ? "unavailable"
        : !p.shipGiven && p.step === "details"
          ? "missing"
          : null;
  return {
    step,
    reachable,
    issues,
    destinationOk,
    showDestinationErrors:
      step === "destination" && p.step !== null && p.step !== "destination",
    offeredShip: offered ? p.ship : null,
    checkedMethod: offered && p.ship !== null ? p.ship : quote.selected,
    deliveryProblem,
  };
}

/** What a checkout URL carries. */
export interface CheckoutState {
  country: string;
  city: string;
  zip: string;
  ship: string | null;
  cur: "USD" | null;
  pack?: "rolled" | null;
  step?: CheckoutStep | null;
}

/**
 * The query for a checkout URL: empty values are dropped, and so are a city or postal code over
 * the limits (they could never pass step 1, and links must not carry them on).
 */
export function checkoutQuery(s: CheckoutState): CheckoutQuery {
  const query: CheckoutQuery = {};
  if (s.country) query.to = s.country;
  if (s.city && s.city.length <= DESTINATION_LIMITS.city) query.city = s.city;
  if (s.zip && s.zip.length <= DESTINATION_LIMITS.postalCode) {
    query.zip = s.zip;
  }
  if (s.ship) query.ship = s.ship;
  if (s.pack) query.pack = s.pack;
  if (s.cur) query.cur = s.cur;
  if (s.step) query.step = s.step;
  return query;
}

export interface StepLinks {
  /** Step 1, prefilled ("Change" destination). */
  destination: string;
  /** Step 2 ("Change" delivery method). */
  delivery: string;
  /** Step 2 priced in shekels / in dollars (abroad, when the works have USD prices). */
  currency: { ILS: string; USD: string };
  /** Step 2 priced as listed (stretched, in a box) / rolled in a tube. */
  packing: { STRETCHED: string; ROLLED: string };
  /** No `step`, so as far as the data allows: the "show the updated total" link. */
  details: string;
}

/**
 * The checkout's own links for the current state. Pass the offered method as `ship` (a method the
 * destination does not offer is not carried on), the effective currency as `cur` and the effective
 * packing as `pack`.
 */
export function stepLinks(
  href: (query: CheckoutQuery) => string,
  s: CheckoutState,
): StepLinks {
  const at = (change: Partial<CheckoutState>) =>
    href(checkoutQuery({ ...s, ...change }));
  return {
    destination: at({ step: "destination" }),
    delivery: at({ step: "delivery" }),
    currency: {
      ILS: at({ cur: null, step: "delivery" }),
      USD: at({ cur: "USD", step: "delivery" }),
    },
    packing: {
      STRETCHED: at({ pack: null, step: "delivery" }),
      ROLLED: at({ pack: "rolled", step: "delivery" }),
    },
    details: at({ step: null }),
  };
}
