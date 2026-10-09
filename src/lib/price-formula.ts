/**
 * The painter's price formula (docs/pricing/pricing-procedure.tex). Pure: the catalog seed prices
 * every work with it, and the documentation's examples are checked against it by
 * tests/unit/price-formula.test.ts.
 *
 *   price = round_100( referenceIls × medium factor × surface factor × (area / referenceArea)^0.6 )
 *           + framedAddIls (framed works only)
 *
 * - The reference work is an 80 × 80 cm acrylic on canvas, her most common size.
 * - The exponent 0.6 makes price grow with size, but less than in proportion to the area (the
 *   size elasticity art-market research finds for contemporary painting).
 * - Materials scale the price: oil on canvas +15 %, board or panel −5 %, works on paper −35 %.
 * - The dollar price (shown to buyers abroad) is the shekel price at the site's reference rate,
 *   rounded to $10.
 *
 * Changing a parameter changes every price in the same proportion, so the price list stays
 * consistent; update the procedure document's examples together with it.
 */

export const MEDIUMS = [
  "OIL",
  "ACRYLIC",
  "WATERCOLOR",
  "GOUACHE",
  "INK",
  "CHARCOAL",
  "PASTEL",
  "TEMPERA",
  "MIXED_MEDIA",
  "OTHER",
] as const;
export type PricingMedium = (typeof MEDIUMS)[number];

export const SURFACES = [
  "CANVAS",
  "LINEN",
  "WOOD_PANEL",
  "BOARD",
  "CARDBOARD",
  "PAPER",
  "OTHER",
] as const;
export type PricingSurface = (typeof SURFACES)[number];

export const PRICING = {
  /** Price in NIS of the reference work: an 80 × 80 cm acrylic on canvas. */
  referenceIls: 4_800,
  /** Area of the reference work in cm². */
  referenceAreaCm2: 80 * 80,
  /** Size elasticity: price ∝ area^0.6. */
  sizeExponent: 0.6,
  /** NIS prices are rounded to this step. */
  roundIls: 100,
  /** Added to the price of a framed work (the frame's cost); 0 until the painter sets it. */
  framedAddIls: 0,
  /** Reference rate for the dollar price (as `settings.checkout.fx.ilsPerUsd`). */
  ilsPerUsd: 3.7,
  /** Dollar prices are rounded to this step. */
  roundUsd: 10,
} as const;

/** Oil commands a premium over acrylic; other media price like acrylic. */
export const MEDIUM_FACTOR: Record<PricingMedium, number> = {
  OIL: 1.15,
  ACRYLIC: 1,
  WATERCOLOR: 1,
  GOUACHE: 1,
  INK: 1,
  CHARCOAL: 1,
  PASTEL: 1,
  TEMPERA: 1,
  MIXED_MEDIA: 1,
  OTHER: 1,
};

/** Canvas is the base; board or panel sits slightly below; paper well below. */
export const SURFACE_FACTOR: Record<PricingSurface, number> = {
  CANVAS: 1,
  LINEN: 1,
  WOOD_PANEL: 0.95,
  BOARD: 0.95,
  CARDBOARD: 0.95,
  PAPER: 0.65,
  OTHER: 1,
};

export interface PricedWork {
  heightMm: number;
  widthMm: number;
  medium: PricingMedium;
  surface: PricingSurface;
  framed?: boolean;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** The NIS price of a work under the formula (whole shekels). */
export function formulaPriceIls(work: PricedWork): number {
  const areaCm2 = (work.heightMm / 10) * (work.widthMm / 10);
  const raw =
    PRICING.referenceIls *
    MEDIUM_FACTOR[work.medium] *
    SURFACE_FACTOR[work.surface] *
    (areaCm2 / PRICING.referenceAreaCm2) ** PRICING.sizeExponent;
  return (
    roundTo(raw, PRICING.roundIls) + (work.framed ? PRICING.framedAddIls : 0)
  );
}

/** The dollar price for a NIS price (whole dollars). */
export function formulaPriceUsd(
  ils: number,
  ilsPerUsd: number = PRICING.ilsPerUsd,
): number {
  return roundTo(ils / ilsPerUsd, PRICING.roundUsd);
}
