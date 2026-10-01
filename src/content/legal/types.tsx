import type { ReactNode } from "react";

/**
 * What the legal pages may show about the seller (spec §1.2, §6.2): built from
 * `business_profile` **without `idNumber`** — this type has no such field on purpose, so a legal
 * page cannot print it. Values are already in the page's locale.
 */
export interface LegalProfile {
  legalName: string;
  tradeName: string;
  artistName: string;
  vatMode: "OSEK_PATUR" | "OSEK_MURSHE";
  address: string;
  returnAddress: string;
  phoneLocal: string;
  phoneIntl: string;
  email: string;
  accessibilityContact: string;
  privacyContact: string;
  pickupAddress: string;
}

export interface LegalDocProps {
  profile: LegalProfile;
  /** Absolute or locale-prefixed links to the sibling pages. */
  links: {
    terms: string;
    returns: string;
    shipping: string;
    privacy: string;
    accessibility: string;
    cancel: string;
  };
  /** Display date of the version ("1 October 2026"). */
  versionDate: string;
}

export interface LegalDocModule {
  title: string;
  Body: (props: LegalDocProps) => ReactNode;
}

export function H2({ children }: { children: ReactNode }) {
  return <h2 className="mbs-6 text-2xl">{children}</h2>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="max-w-prose">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="flex max-w-prose list-disc flex-col gap-1 ps-5">
      {children}
    </ul>
  );
}

/** Phones, emails and addresses keep their direction inside Hebrew text. */
export function L({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="underline">
      {children}
    </a>
  );
}
