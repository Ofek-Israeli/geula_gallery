import { A, H2, L, type LegalDocModule, P, UL } from "../types";

/** Warranty policy (Isracard's online-acceptance form, "warranty policy for the products"). */
export const warranty: LegalDocModule = {
  title: "Warranty",
  Body: ({ profile: p, links }) => (
    <>
      <H2>1. Authenticity</H2>
      <P>
        Every work on this site is a unique original by {p.artistName}, and
        every work comes with a certificate of authenticity. We stand behind the
        work you receive being the work shown on the site and matching its
        description: the medium, the materials and the dimensions (within a few
        millimetres). If a work does not match its description, you may cancel
        and receive a full refund, including shipping, with no cancellation fee.
      </P>

      <H2>2. Condition on delivery and transit damage</H2>
      <P>
        Works are packed carefully, with nothing touching the paint surface, and
        travel with tracking. If a work arrives defective or damaged:
      </P>
      <UL>
        <li>
          please photograph the parcel before opening it, and the work and the
          damage afterwards;
        </li>
        <li>
          please contact us within 14 days of delivery, with the order number
          and the photos;
        </li>
        <li>
          at your choice: a professional repair at our expense, or the return of
          the work at our expense and a full refund, including shipping.
        </li>
      </UL>

      <H2>3. Materials and workmanship</H2>
      <P>
        For 12 months from delivery, if a defect in the materials or the
        workmanship appears that is not caused by an external factor – for
        example paint flaking or cracking, or canvas coming loose from its
        stretcher – we will examine the work and repair it free of charge. If a
        repair is not possible, we will offer a refund against the return of the
        work.
      </P>

      <H2>4. What is not covered</H2>
      <UL>
        <li>natural changes in the materials over time;</li>
        <li>
          damage from long exposure to direct sunlight, humidity, heat or a
          nearby heat source;
        </li>
        <li>
          damage from handling, hanging, cleaning with liquids or repairs by
          someone else after delivery;
        </li>
        <li>
          a painting delivered rolled in a tube: re-stretching it on a frame is
          not included, as described on the{" "}
          <A href={links.shipping}>shipping and duties</A> page.
        </li>
      </UL>

      <H2>5. Caring for the work</H2>
      <P>
        Hang the work away from direct sunlight and humidity, and dust it gently
        with a soft, dry brush only.
      </P>

      <H2>6. How to reach us</H2>
      <P>
        By phone at <L>{p.phoneIntl}</L>
        {p.email ? (
          <>
            , by email at <L>{p.email}</L>
          </>
        ) : null}{" "}
        or through the <A href={links.contact}>contact form</A>. Please give the
        order number and attach photos. We reply within 14 days.
      </P>

      <H2>7. Your statutory rights</H2>
      <P>
        This policy does not limit your rights under the Consumer Protection Law
        or any other law, including the right to cancel described on the{" "}
        <A href={links.returns}>cancellations and returns</A> page.
      </P>
    </>
  ),
};
