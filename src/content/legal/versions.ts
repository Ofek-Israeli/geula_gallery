/**
 * Versions of the legal texts a buyer accepts at checkout (spec §1.2 "Checkout": click-to-accept
 * with stored versions; spec §4.7 `versions.ts`). Each order stores the versions it was accepted
 * under. `approved: false` shows a DRAFT banner until the lawyer signs the texts off (WS6 owns
 * the texts and bumps these values). The lawyer approved the texts on 2026-10-10. On 2026-10-14
 * the payment paragraph of the terms and of the disclosure (Isracard's secure fields) and the privacy
 * policy's hosting and processors changed, and the warranty policy was added; those changes await
 * the lawyer's review.
 */
export const LEGAL_VERSIONS = {
  terms: "2026-10-14",
  returns: "2026-10-10",
  privacy: "2026-10-14",
  /** DAP duties notice acknowledged by international buyers. */
  dutiesNotice: "2026-10-10",
  /** Pre-contract disclosure / s.14C(b) disclosure document. */
  disclosure: "2026-10-14",
} as const;

export const LEGAL_TEXTS_APPROVED = true;
