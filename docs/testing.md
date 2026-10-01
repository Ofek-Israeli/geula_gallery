# Testing

## Commands

| Command | What it runs |
|---|---|
| `npm run lint` | Biome (`biome check .`) |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run check:secrets` | secret / PII scanner over the working tree (`-- --stdin` for history patches) |
| `npm test` | Vitest `unit` + `contract` projects (no database) |
| `npm run test:integration` | Vitest `integration` project on a real local Postgres (`TEST_DATABASE_URL`, dropped and re-migrated per run, files serially) |
| `npm run test:e2e [-- <specs>]` | Playwright: resets `E2E_DATABASE_URL` with the demo seed, builds into `.next-e2e`, serves on `E2E_PORT` |
| `npm run verify` | lint + typecheck + check:secrets + test + test:integration |
| `npm run verify:all` | verify + build + test:e2e |

Live provider checks are opt-in and never part of `verify` (`CARDCOM_CONTRACT=1 npm run
test:contract`, `npm run check:cardcom`, … — see spec §10.5).

**Worktree gotcha:** running `next dev`/`next build` with a custom `NEXT_DIST_DIR` rewrites
`tsconfig.json`. Revert it (`git checkout tsconfig.json`) before committing. Running
`NEXT_DIST_DIR=.next-e2e npm run typecheck` avoids the rewrite (those entries are pre-added).

## Compliance coverage (WS6)

| Area | Tests |
|---|---|
| Deadlines and fee | `tests/unit/deadlines.test.ts` (14 days from the later of delivery and disclosure, cancellation before delivery, 4 months only with eligibility **and** a conversation, refund due = notice + 14 days, DST, ₪1,500 → ₪75, ₪20,000 → ₪100, EU and defect → 0, USD with the locked rate) |
| Legal texts | `tests/unit/legal-content.test.ts` (s.14C(a) elements in the pre-contract disclosure; forbidden phrases absent; the seller ID number never in legal pages or the footer) |
| AIC dimensions | `tests/unit/aic-dimensions.test.ts` |
| Cancellations | `tests/integration/cancellations.test.ts` (auto-match, double submission and web-then-phone notices both stored, duplicates, window incl. 4 months, conversation detected from a buyer request, COMPLETED order → CANCELLED, fee, EU, due date from the notice, relist, sealed review payload, masked acknowledgement emails) |
| Invariants and go-live | `tests/integration/invariants.test.ts` (the demo seed with the three sample orders is consistent; every check catches a broken row) |
| Retention | `tests/integration/purge.test.ts` |
| Daily job | `tests/integration/daily-job.test.ts` (COMPLETED transitions, refund deadline alerts, `admin-alert` emails) |
| Disclosure PDF (Tier B) | `tests/integration/disclosure-pdf.test.ts` |
| End to end | `tests/e2e/cancellation-il.spec.ts` (name + ID form, the ID never in the URL, review → confirm → acknowledgement + email with the ID masked, resubmission as a possible duplicate, admin match / duplicate / accept with fee → refund → credit note → CANCELLED → close → relist; legal pages link to the cancel page) |

## QA checklist (spec §10.6)

### Agent-verifiable
- [ ] RTL mirroring from Playwright screenshots at 360, 390 and 1280 px, in he and en.
- [ ] Prices, dimensions, phones, emails and order/cancellation numbers are not mirrored (`<bdi dir="ltr">`).
- [ ] Keyboard-only checkout, lightbox, dialogs and the cancellation form (review and confirm are plain buttons).
- [ ] axe results (zero serious/critical) in both locales.
- [ ] A4 print output of every printable via `page.pdf()`: disclosure, mock receipt, packing slip, commercial invoice, COA, studio notice.
- [ ] Emails in he and en from `email_messages` (log driver), including the disclosure PDF attachment.
- [ ] Reduced-motion emulation.
- [ ] Lighthouse only if `npx lighthouse` runs headless locally; otherwise a user item.

### For the user or the painter
- [ ] VoiceOver in he and en.
- [ ] The artwork editor on a real phone, uploading from the camera roll.
- [ ] 200% zoom.
- [ ] Lighthouse on a real device.
- [ ] Final legal and visual sign-off.
