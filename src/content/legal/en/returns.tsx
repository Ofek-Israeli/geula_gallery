import { A, H2, L, type LegalDocModule, P, UL } from "../types";

/** Cancellations and returns – draft for the lawyer's review (spec §5.7). */
export const returns: LegalDocModule = {
  title: "Cancellations and returns",
  Body: ({ profile: p, links }) => (
    <>
      <H2>When you can cancel</H2>
      <UL>
        <li>
          Within 14 days of receiving the work or the disclosure document,
          whichever is later. You may also cancel before the work is delivered.
        </li>
        <li>
          Senior citizens (65+), people with disabilities and new immigrants (up
          to 5 years since immigration) whose purchase involved a conversation
          with the seller: within 4 months, as the law provides.
        </li>
      </UL>

      <H2>How to cancel</H2>
      <P>
        You may give notice in any of these ways; every notice is recorded and
        acknowledged:
      </P>
      <UL>
        <li>
          the online form on the <A href={links.cancel}>cancel a purchase</A>{" "}
          page – your full name and ID number, or your order number, are enough;
        </li>
        <li>
          by phone: <L>{p.phoneLocal}</L> (international: <L>{p.phoneIntl}</L>
          );
        </li>
        <li>
          by email: <L>{p.email}</L>
          {";"}
        </li>
        <li>by registered mail: {p.address}.</li>
      </UL>

      <H2>Cancellation fee</H2>
      <P>
        A cancellation that is not due to a defect, a mismatch with the
        description or non-delivery may carry a fee of up to 5% of the price or
        ₪100, whichever is lower. There is no fee for a defect or a mismatch.
      </P>

      <H2>Refund</H2>
      <P>
        Refunds go back to the original payment method no later than 14 days
        after we receive your notice. Payments made in US dollars are refunded
        in US dollars.
      </P>

      <H2>Returning the work</H2>
      <P>
        If the work was already delivered, we will send return instructions.
        Please return it in protective packaging, with tracking, to:{" "}
        {p.returnAddress}. A collection can be arranged by phone. [For the
        lawyer: who pays the return shipping.]
      </P>

      <H2>Commissions</H2>
      <P>
        A work made specially to the buyer's specification (a commission) may be
        excluded from cancellation under s.14C(d) of the law, subject to the
        law's qualifications (including s.2(b2)). Works from the collection on
        this site are not commissions.
      </P>
    </>
  ),
};
