import { A, H2, L, type LegalDocModule, P, UL } from "../types";

/** Terms of sale – draft for the lawyer's review (spec §6.2, §12.4). */
export const terms: LegalDocModule = {
  title: "Terms of sale",
  Body: ({ profile: p, links }) => (
    <>
      <H2>1. The seller</H2>
      <P>
        This site is operated by {p.legalName} ({p.tradeName}), address:{" "}
        {p.address}. Phone: <L>{p.phoneLocal}</L> (international:{" "}
        <L>{p.phoneIntl}</L>), email: <L>{p.email}</L>. Merchant country:
        Israel. The seller's identification details appear on the payment page,
        in the disclosure document and in the order confirmation.
      </P>

      <H2>2. The works</H2>
      <P>
        Every work is a unique original by {p.artistName}. The photographs
        represent each work as faithfully as possible; colours may differ
        slightly between screens. Dimensions are given in centimetres and inches
        and may vary by a few millimetres.
      </P>

      <H2>3. Prices</H2>
      <UL>
        <li>
          Prices are shown in Israeli shekels (ILS) and are binding.{" "}
          {p.vatMode === "OSEK_PATUR"
            ? "The seller is VAT-exempt (osek patur), so no VAT is charged."
            : "Prices include VAT."}
        </li>
        <li>
          Buyers shipping abroad may pay in US dollars where a dollar price
          exists; the amount is shown before payment.
        </li>
        <li>
          Shipping and insurance (when included) are shown separately on the
          payment page before you confirm.
        </li>
      </UL>

      <H2>4. Placing an order</H2>
      <P>
        When you select "Continue to payment" the work is reserved for you for
        35 minutes. The contract is formed when the payment provider confirms
        your payment. If the payment is not completed no contract is formed and
        the work becomes available again. If a payment arrives for a work that
        has already been sold, it is refunded in full.
      </P>

      <H2>5. Payment</H2>
      <P>
        You pay on the payment provider's secure page (Cardcom or PayPal). Card
        details never pass through or stay on this site. A receipt is emailed if
        you ask for it, and is always included with the work.
      </P>

      <H2>6. Delivery</H2>
      <P>
        Delivery methods, times and costs are described on the{" "}
        <A href={links.shipping}>shipping and duties</A> page. International
        shipments are DAP: import duties and taxes, if any, are paid by the
        buyer on delivery.
      </P>

      <H2>7. Cancellation</H2>
      <P>
        You may cancel as described on the{" "}
        <A href={links.returns}>cancellations and returns</A> page, in any of
        the ways listed on the <A href={links.cancel}>cancel a purchase</A>{" "}
        page, including an online form.
      </P>

      <H2>8. Copyright</H2>
      <P>
        Copyright and the moral rights in each work remain with the artist. The
        purchase transfers ownership of the single original; it grants no right
        to reproduce, print or commercially use the work or its images.
      </P>

      <H2>9. Privacy and accessibility</H2>
      <P>
        How we use personal data is described in the{" "}
        <A href={links.privacy}>privacy policy</A>. Accessibility information is
        in the <A href={links.accessibility}>accessibility statement</A>.
      </P>

      <H2>10. Law</H2>
      <P>
        These terms are governed by Israeli law. Nothing in them limits your
        rights under the Consumer Protection Law or any other law.
      </P>
    </>
  ),
};
