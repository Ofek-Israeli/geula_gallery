import { A, H2, L, type LegalDocModule, P, UL } from "../types";

/** Accessibility statement (voluntary) – draft (spec §6.7). */
export const accessibility: LegalDocModule = {
  title: "Accessibility statement",
  Body: ({ profile: p, links, versionDate }) => (
    <>
      <P>
        We want this site to be usable by everyone. It is built to meet WCAG 2.2
        level AA and Israeli Standard 5568, without third-party accessibility
        overlays.
      </P>

      <H2>What we did</H2>
      <UL>
        <li>
          Full keyboard navigation, a "skip to content" link and visible focus.
        </li>
        <li>Correct headings and landmarks; one main heading per page.</li>
        <li>Hebrew and English alternative text for every artwork image.</li>
        <li>
          Availability (available, reserved, sold) is always shown as text, not
          only colour.
        </li>
        <li>
          Forms with visible labels, marked required fields and detailed error
          messages.
        </li>
        <li>Support for text zoom and reduced motion.</li>
      </UL>

      <H2>Known limitations</H2>
      <UL>
        <li>
          PDF documents (such as the disclosure attached to emails) are not
          tagged for accessibility; an accessible HTML version of each exists on
          the site.
        </li>
      </UL>

      <H2>Contact</H2>
      <P>
        Found a problem? Tell us and we will fix it:{" "}
        {p.accessibilityContact ? (
          <L>{p.accessibilityContact}</L>
        ) : (
          <A href={links.contact}>the contact form</A>
        )}
        , phone <L>{p.phoneIntl}</L>.
      </P>
      <P>This statement was updated on {versionDate}.</P>
    </>
  ),
};
