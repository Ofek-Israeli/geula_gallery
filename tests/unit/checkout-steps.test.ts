import { describe, expect, it } from "vitest";
import {
  type CheckoutSearchParams,
  type CheckoutStep,
  checkoutQuery,
  type DeliveryProblem,
  parseCheckoutParams,
  resolveCheckoutStep,
  stepLinks,
} from "@/lib/checkout-steps";
import { paths } from "@/lib/routes";

const OFFERED = new Set(["IL", "US", "HK", "GB"]);
const METHODS: Record<string, string[]> = {
  IL: ["CARRIER_TABLE", "ISRAEL_POST", "LOCAL_PICKUP"],
  US: ["CARRIER_TABLE"],
  HK: ["CARRIER_TABLE"],
  AQ: ["CARRIER_TABLE"],
};

/** Resolves a query the way the page does, with the quote picking like `getCheckoutQuote`. */
function resolve(sp: CheckoutSearchParams) {
  const p = parseCheckoutParams(sp);
  const methods = METHODS[p.country] ?? ["CARRIER_TABLE"];
  const selected =
    p.ship !== null && methods.includes(p.ship)
      ? p.ship
      : (methods[0] ?? "CARRIER_TABLE");
  return resolveCheckoutStep(p, { methods, selected }, OFFERED);
}

describe("parseCheckoutParams", () => {
  it("reads the first value of repeated keys, trims and upper-cases the country", () => {
    const p = parseCheckoutParams({
      to: [" us ", "IL"],
      city: [" Springfield ", "Boston"],
      zip: " 62701 ",
    });
    expect(p).toMatchObject({
      country: "US",
      city: "Springfield",
      zip: "62701",
    });
  });

  it("defaults to Israel with an empty destination", () => {
    expect(parseCheckoutParams({})).toEqual({
      country: "IL",
      city: "",
      zip: "",
      ship: null,
      shipGiven: false,
      cur: null,
      pack: null,
      step: null,
    });
    expect(parseCheckoutParams({ to: "  " }).country).toBe("IL");
  });

  it("reads the packing: rolled, or as listed", () => {
    expect(parseCheckoutParams({ pack: "rolled" }).pack).toBe("rolled");
    expect(parseCheckoutParams({ pack: " rolled " }).pack).toBe("rolled");
    expect(parseCheckoutParams({ pack: "ROLLED" }).pack).toBeNull();
    expect(parseCheckoutParams({ pack: "stretched" }).pack).toBeNull();
  });

  it("keeps known methods only, but notes that a method was asked for", () => {
    expect(parseCheckoutParams({ ship: "LOCAL_PICKUP" })).toMatchObject({
      ship: "LOCAL_PICKUP",
      shipGiven: true,
    });
    expect(parseCheckoutParams({ ship: "QUOTED" })).toMatchObject({
      ship: null,
      shipGiven: true,
    });
    expect(parseCheckoutParams({ ship: "<junk>" })).toMatchObject({
      ship: null,
      shipGiven: true,
    });
    expect(parseCheckoutParams({ ship: "" }).shipGiven).toBe(false);
  });

  it("keeps cur=USD only and known steps only", () => {
    expect(parseCheckoutParams({ cur: "USD" }).cur).toBe("USD");
    expect(parseCheckoutParams({ cur: "usd" }).cur).toBeNull();
    expect(parseCheckoutParams({ cur: "ILS" }).cur).toBeNull();
    expect(parseCheckoutParams({ step: "details" }).step).toBe("details");
    expect(parseCheckoutParams({ step: "payment" }).step).toBeNull();
    expect(parseCheckoutParams({ step: ["delivery", "x"] }).step).toBe(
      "delivery",
    );
  });
});

describe("resolveCheckoutStep", () => {
  const cases: [
    string,
    CheckoutSearchParams,
    {
      step: CheckoutStep;
      errors?: boolean;
      problem?: DeliveryProblem | null;
      checked?: string;
      offeredShip?: string | null;
    },
  ][] = [
    ["bare URL: step 1, no errors", {}, { step: "destination", errors: false }],
    [
      "step 1 submitted without a city: step 1 with errors",
      { to: "IL", city: "", step: "delivery" },
      { step: "destination", errors: true },
    ],
    [
      "Change destination with a valid destination: step 1, no errors",
      { to: "IL", city: "Haifa", ship: "LOCAL_PICKUP", step: "destination" },
      { step: "destination", errors: false, offeredShip: "LOCAL_PICKUP" },
    ],
    [
      "deep link without a city: step 1, no errors",
      { to: "US", ship: "CARRIER_TABLE" },
      { step: "destination", errors: false },
    ],
    [
      "a later step asked for with an incomplete destination: step 1 with errors",
      { to: "IL", ship: "LOCAL_PICKUP", step: "details" },
      { step: "destination", errors: true },
    ],
    [
      "US without a postal code: step 1 with errors",
      { to: "US", city: "Springfield", step: "delivery" },
      { step: "destination", errors: true },
    ],
    [
      "a country the selector does not offer: step 1 with errors",
      { to: "AQ", city: "McMurdo", step: "delivery" },
      { step: "destination", errors: true },
    ],
    [
      "step 1 submitted: step 2, the quote's method checked",
      { to: "IL", city: "Haifa", step: "delivery" },
      { step: "delivery", problem: null, checked: "CARRIER_TABLE" },
    ],
    [
      "Hong Kong needs no postal code: step 2",
      { to: "HK", city: "Kowloon", step: "delivery" },
      { step: "delivery", problem: null },
    ],
    [
      "Change delivery: step 2 with the chosen method checked",
      { to: "IL", city: "Haifa", ship: "LOCAL_PICKUP", step: "delivery" },
      { step: "delivery", problem: null, checked: "LOCAL_PICKUP" },
    ],
    [
      "step 2 submitted with a method not offered here: step 2, unavailable",
      {
        to: "US",
        city: "Springfield",
        zip: "62701",
        ship: "LOCAL_PICKUP",
        step: "details",
      },
      {
        step: "delivery",
        problem: "unavailable",
        checked: "CARRIER_TABLE",
        offeredShip: null,
      },
    ],
    [
      "deep link with a method not offered here: step 2, unavailable",
      { to: "US", city: "Springfield", zip: "62701", ship: "LOCAL_PICKUP" },
      { step: "delivery", problem: "unavailable" },
    ],
    [
      "switching country with a domestic method carried along: no notice",
      {
        to: "US",
        city: "Springfield",
        zip: "62701",
        ship: "LOCAL_PICKUP",
        step: "delivery",
      },
      { step: "delivery", problem: null, offeredShip: null },
    ],
    [
      "step 2 submitted without a method: step 2, missing",
      { to: "IL", city: "Haifa", step: "details" },
      { step: "delivery", problem: "missing" },
    ],
    [
      "a junk or quoted method: step 2, unavailable",
      { to: "IL", city: "Haifa", ship: "QUOTED", step: "details" },
      { step: "delivery", problem: "unavailable" },
    ],
    [
      "step 2 submitted: step 3",
      { to: "IL", city: "Haifa", ship: "LOCAL_PICKUP", step: "details" },
      { step: "details", problem: null, offeredShip: "LOCAL_PICKUP" },
    ],
    [
      "complete deep link (the reload link): step 3",
      { to: "IL", city: "Tel Aviv", zip: "6100000", ship: "CARRIER_TABLE" },
      { step: "details" },
    ],
  ];

  for (const [name, sp, want] of cases) {
    it(name, () => {
      const r = resolve(sp);
      expect(r.step).toBe(want.step);
      if (want.errors !== undefined) {
        expect(r.showDestinationErrors).toBe(want.errors);
      }
      if (want.problem !== undefined) {
        expect(r.deliveryProblem).toBe(want.problem);
      }
      if (want.checked !== undefined) {
        expect(r.checkedMethod).toBe(want.checked);
      }
      if (want.offeredShip !== undefined) {
        expect(r.offeredShip).toBe(want.offeredShip);
      }
    });
  }

  it("reports the destination issues and the furthest reachable step", () => {
    const r = resolve({ to: "US", city: "ניו יורק", step: "details" });
    expect(r.issues).toEqual({ city: "latin_only", postalCode: "required" });
    expect(r.destinationOk).toBe(false);
    expect(r.reachable).toBe("destination");
    const ok = resolve({ to: "IL", city: "Haifa", step: "destination" });
    expect(ok.reachable).toBe("delivery");
    expect(ok.destinationOk).toBe(true);
  });
});

describe("checkoutQuery and stepLinks", () => {
  it("drops empty values and a city or postal code over the limits", () => {
    expect(
      checkoutQuery({
        country: "IL",
        city: "",
        zip: "",
        ship: null,
        cur: null,
      }),
    ).toEqual({ to: "IL" });
    expect(
      checkoutQuery({
        country: "US",
        city: "x".repeat(121),
        zip: "1".repeat(21),
        ship: "CARRIER_TABLE",
        cur: "USD",
        step: "delivery",
      }),
    ).toEqual({
      to: "US",
      ship: "CARRIER_TABLE",
      cur: "USD",
      step: "delivery",
    });
    expect(
      checkoutQuery({
        country: "IL",
        city: "x".repeat(120),
        zip: "1".repeat(20),
        ship: null,
        cur: null,
        step: null,
      }),
    ).toEqual({ to: "IL", city: "x".repeat(120), zip: "1".repeat(20) });
  });

  it("builds the Change, currency and reload links", () => {
    const links = stepLinks((q) => paths.checkout("the-path", q), {
      country: "IL",
      city: "Tel Aviv",
      zip: "6100000",
      ship: "LOCAL_PICKUP",
      cur: null,
    });
    const base = "/checkout/the-path?to=IL&city=Tel+Aviv&zip=6100000";
    expect(links.destination).toBe(
      `${base}&ship=LOCAL_PICKUP&step=destination`,
    );
    expect(links.delivery).toBe(`${base}&ship=LOCAL_PICKUP&step=delivery`);
    // The reload link has no step (as far as the data allows) and keeps city and postal code.
    expect(links.details).toBe(`${base}&ship=LOCAL_PICKUP`);
    expect(links.currency.USD).toBe(
      `${base}&ship=LOCAL_PICKUP&cur=USD&step=delivery`,
    );
    expect(links.currency.ILS).toBe(`${base}&ship=LOCAL_PICKUP&step=delivery`);
    expect(links.packing.ROLLED).toBe(
      `${base}&ship=LOCAL_PICKUP&pack=rolled&step=delivery`,
    );
    expect(links.packing.STRETCHED).toBe(
      `${base}&ship=LOCAL_PICKUP&step=delivery`,
    );
  });

  it("keeps the rolled packing on every link but the stretched one", () => {
    const links = stepLinks((q) => paths.checkout("the-path", q), {
      country: "CA",
      city: "Toronto",
      zip: "M5V 2T6",
      ship: "ISRAEL_POST",
      cur: null,
      pack: "rolled",
    });
    const base = "/checkout/the-path?to=CA&city=Toronto&zip=M5V+2T6";
    expect(links.destination).toBe(
      `${base}&ship=ISRAEL_POST&pack=rolled&step=destination`,
    );
    expect(links.details).toBe(`${base}&ship=ISRAEL_POST&pack=rolled`);
    expect(links.currency.USD).toBe(
      `${base}&ship=ISRAEL_POST&pack=rolled&cur=USD&step=delivery`,
    );
    expect(links.packing.STRETCHED).toBe(
      `${base}&ship=ISRAEL_POST&step=delivery`,
    );
  });

  it("keeps the effective currency on every link but the shekel one", () => {
    const links = stepLinks((q) => paths.cartCheckout(q), {
      country: "US",
      city: "Springfield",
      zip: "62701",
      ship: null,
      cur: "USD",
    });
    expect(links.delivery).toBe(
      "/checkout?to=US&city=Springfield&zip=62701&cur=USD&step=delivery",
    );
    expect(links.currency.ILS).toBe(
      "/checkout?to=US&city=Springfield&zip=62701&step=delivery",
    );
    expect(links.details).toBe(
      "/checkout?to=US&city=Springfield&zip=62701&cur=USD",
    );
  });
});
