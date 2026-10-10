import { H2, type LegalDocModule, P, UL } from "../types";

/** Shipping and duties – draft (spec §4.4). */
export const shipping: LegalDocModule = {
  title: "Shipping and duties",
  Body: ({ profile: p }) => (
    <>
      <H2>Delivery in Israel</H2>
      <UL>
        <li>Courier delivery to your door, with tracking.</li>
        <li>
          Israel Post home delivery, with tracking, when the parcel is within
          Israel Post's size limits.
        </li>
        <li>Free pickup from the studio: {p.pickupAddress}.</li>
      </UL>
      <P>
        The cost and the estimated delivery time are shown on the artwork page
        and at checkout, before you pay. Works usually leave the studio within a
        few business days of payment.
      </P>
      <P>
        At checkout you may choose to receive a painting on canvas rolled in a
        tube, off its stretcher. Shipping then costs less; re-stretching it on a
        frame is not included.
      </P>

      <H2>International shipping</H2>
      <P>
        International shipments travel with tracking through an international
        carrier. A shipment is described as "insured" only when insurance is
        actually included in the quote, up to the amount shown. We do not ship
        to some destinations, and for some destinations and works (including
        large or high-value works) we prepare an individual quote.
      </P>

      <H2>Duties and taxes (DAP)</H2>
      <P>
        International shipments are DAP: import duties, VAT and clearance fees,
        if any, are paid by the buyer on delivery and are not included in the
        price. You confirm this before paying.
      </P>

      <H2>Packing and transit damage</H2>
      <P>
        Works are packed carefully, with nothing touching the paint surface. If
        a parcel arrives damaged, please photograph it before opening and
        contact us promptly so we can claim with the carrier.
      </P>
      <P>
        A printed disclosure document is included with every shipment and every
        pickup.
      </P>
    </>
  ),
};
