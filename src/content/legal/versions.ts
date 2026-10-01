/**
 * Versions of the legal texts a buyer accepts at checkout (spec §1.2 "Checkout": click-to-accept
 * with stored versions; spec §4.7 `versions.ts`). Each order stores the versions it was accepted
 * under. `approved: false` shows a DRAFT banner until the lawyer signs the texts off (WS6 owns
 * the texts and bumps these values).
 */
export const LEGAL_VERSIONS = {
  terms: "2026-10-01-draft",
  returns: "2026-10-01-draft",
  privacy: "2026-10-01-draft",
  /** DAP duties notice acknowledged by international buyers. */
  dutiesNotice: "2026-10-01-draft",
  /** Pre-contract disclosure / s.14C(b) disclosure document. */
  disclosure: "2026-10-01-draft",
} as const;

export const LEGAL_TEXTS_APPROVED = false;
