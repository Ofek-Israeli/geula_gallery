import { H2, L, type LegalDocModule, P, UL } from "../types";

/** Privacy policy – draft (Amendment 13; spec §7). */
export const privacy: LegalDocModule = {
  title: "Privacy policy",
  Body: ({ profile: p }) => (
    <>
      <H2>Who is responsible</H2>
      <P>
        The database owner is {p.legalName}, {p.address}. Privacy enquiries:{" "}
        <L>{p.privacyContact}</L>.
      </P>

      <H2>What we collect and why</H2>
      <UL>
        <li>
          Orders: name, email, phone and delivery address – to fulfil the order,
          deliver the work and issue the receipt.
        </li>
        <li>Questions and requests: the details you send – to reply.</li>
        <li>
          Cancellation notices: name, ID or passport number (stored encrypted
          and shown only partially) and contact details – to handle and record
          the cancellation as the law requires.
        </li>
        <li>
          IP addresses are stored only as a one-way keyed hash, to prevent
          abuse. We use no analytics, no advertising and no non-essential
          cookies.
        </li>
      </UL>
      <P>
        You are not legally required to give these details, but without them we
        cannot complete the requested action.
      </P>

      <H2>Who receives it</H2>
      <P>Only the service providers needed for each action, as needed:</P>
      <UL>
        <li>Vercel (hosting) and Neon (database), in the European Union;</li>
        <li>
          Resend (email delivery) – data may be stored in the United States;
        </li>
        <li>Cardcom and PayPal (payments);</li>
        <li>Morning (receipts);</li>
        <li>DHL and other carriers (shipping and tracking).</li>
      </UL>

      <H2>How long we keep it</H2>
      <UL>
        <li>Paid orders, tax documents and cancellations: 7 years.</li>
        <li>Unpaid orders: buyer details are erased after 30 days.</li>
        <li>Cancellation notices not matched to an order: 2 years.</li>
        <li>Closed requests: 24 months.</li>
        <li>Email copies: 30 days; tracking data: 30 days after delivery.</li>
      </UL>

      <H2>Your rights</H2>
      <P>
        You may ask to see, correct or delete your data (subject to legal
        retention duties) by writing to <L>{p.privacyContact}</L>. We reply
        within 30 days.
      </P>

      <H2>Security</H2>
      <P>
        Connections are encrypted, the admin area requires a password and
        two-factor authentication, and card details never pass through this
        site.
      </P>
    </>
  ),
};
