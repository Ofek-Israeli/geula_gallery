# Testing

## Commands

| Command | What it runs |
|---|---|
| `npm run lint` | Biome (`biome check .`) |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run check:secrets` | secret and PII scanner over the working tree; `-- --stdin` scans a patch stream such as history |
| `npm test` | Vitest `unit` and `contract` projects (no database) |
| `npm run test:unit` / `npm run test:contract` | one Vitest project |
| `npm run test:integration` | Vitest `integration` project on a real local Postgres (`TEST_DATABASE_URL`, dropped and re-migrated on every run, files run one at a time, tables truncated before each test) |
| `npm run test:e2e [-- <specs or playwright args>]` | Playwright: resets `E2E_DATABASE_URL` with the fixtures seed (the 16 test works), builds into `.next-e2e`, serves on `E2E_PORT` (3100) |
| `npm run verify` | lint + typecheck + check:secrets + test + test:integration |
| `npm run verify:all` | verify + build + test:e2e |

History scan (run before every push):

```bash
git log -p --all --format= | npm run check:secrets -- --stdin
```

### E2E setup

- The web server is a production build (`next start`). It runs on its own database, port and
  dist dir, with a pinned environment:
  - `APP_ENV=test`, `DEMO_MODE=true`, `SEED_E2E_USERS=true`;
  - mock payments, mock carrier, log email and local storage;
  - `RATE_LIMIT_SCALE=100`, `FORM_MIN_AGE_MS=0`, `MOCK_CARRIER_DELIVERY_SECONDS=1`;
  - fixed `e2e-` secrets.
- Every provider credential from the shell or `.env.local` is blanked, so real keys never reach
  the E2E server.
- `E2E_REUSE_SERVER=1` reuses a server already listening on `E2E_PORT`, for local iteration.
  Specs that buy a fixed `e2e-*` clone need a fresh `db:reset`, so on a reused server they fail
  the second time, because the clone is already SOLD.
- Projects:
  - `desktop-chromium`: every spec except `admin-auth`;
  - `mobile-chromium` (Pixel 7): specs tagged `@mobile` or `@smoke`;
  - `auth-limits`: `admin-auth`, which runs last because it trips the sign-in limits.
- `global-setup.ts` signs in once and saves `tests/e2e/.auth/admin.json`. Cron jobs are
  triggered through Playwright's `request` fixture.

### Live sandbox checks (opt-in; never part of `verify`)

| Check | Command | State |
|---|---|---|
| Cardcom | `CARDCOM_CONTRACT=1 npm run test:contract`, `npm run check:cardcom [-- --record --wait]` | **Blocked.** The public test terminal answers HTTP 401 / ResponseCode 603 on both the v11 and the legacy endpoint. The refusal is recorded in `tests/fixtures/cardcom/create-rejected.json`. Needs a real test terminal from Cardcom. |
| PayPal | `PAYPAL_CONTRACT=1 npm run test:contract`, `npm run check:paypal` | Skips cleanly; no sandbox credentials yet. |
| Morning | `MORNING_CONTRACT=1 npm run test:contract`, `npm run check:morning` | Skips cleanly; no sandbox keys yet. |
| DHL | `DHL_CONTRACT=1 npm run test:contract`, `npm run check:dhl` | A read-only call to the public `api-mock.dhl.com` with DHL's published demo pair; the test environment needs an account. |

Set the `*_CONTRACT` flags in the **shell**, not in `.env.local`. Fixtures are written only with
`--record` or `RECORD_FIXTURES=1`.

### Gotchas

- Running `next dev` or `next build` with a custom `NEXT_DIST_DIR` rewrites `tsconfig.json`.
  Revert it (`git checkout tsconfig.json`) before committing. `NEXT_DIST_DIR=.next-e2e npm run
  typecheck` avoids the rewrite, because those entries are pre-added.
- `verify:all` builds into the default `.next`. Stop a `next dev` that uses the same directory
  first, or build elsewhere with `NEXT_DIST_DIR`.
- axe on the lightbox must wait until the fade-in finishes (opacity 1).
- A Server Action form that removes itself on success re-renders without its result message.
  Assert on the resulting state (for example the request status), not on the form's text.

## Latest results (M4, HEAD `c9288ae`, after a fresh `db:reset`)

| Suite | Result |
|---|---|
| lint, typecheck | pass |
| check:secrets (tree) | clean, 641 files |
| check:secrets (full history, `--stdin`) | clean; a planted AWS-style key was flagged as a control |
| unit + contract | 48 files: 482 passed, 4 skipped (the four live-sandbox blocks) |
| integration | 31 files: 264 passed |
| build | pass |
| E2E | 144 passed, 0 failed, 0 flaky, 0 skipped (no `test.fixme` left) |

## Test inventory

### Unit (`tests/unit`, no database)

| Area | Files |
|---|---|
| Money, VAT, formatting | `money`, `vat`, `format`, `display-format`, `dimensions`, `phone`, `il-id`, `countries` (including the countries without postal codes), `ids`, `validation` (including the checkout destination rules) |
| Deadlines and fee | `deadlines`, `cancellation-amounts` (works only on a partial cancellation, shipping with the last work, the shared ₪100 cap, the refund clamped by what is still refundable) |
| Shipping | `shipping-rates` (classes, surcharges, insured value capped before the premium, USD lock, tubes, the §8.3 table, the DHL estimate path and its table fallback), `dhl-tariff` (the published rows agree with DHL's increments; one zone or none per country), `dhl-estimate` (the worked examples and price table of `docs/pricing/shipping-taxes-and-fees.tex`, rounding, surcharges, failures), `shipping-rules`, `shipping-customs` (line values add up to the declared total), `shipping-settings-form` (including the `dhl.*` fields) |
| Commerce | `pricing`, `reservations`, `commerce-state`, `state-machines` (including the repack edges back to AWAITING_FULFILLMENT), `payments-registry`, `cart` (cookie codec, buy-box decisions), `checkout-steps` (the address-first URL contract: parsing, the step resolver, query and link building) |
| Provider maps | `cardcom-map`, `paypal-map`, `morning-map` (with the gateway builder), `dhl-builder`, `dhl-map`, `resend-driver` |
| Platform | `env` (derivations and cross-field rules), `csp`, `security`, `auth-policy`, `storage`, `media-ingest`, `outbox-cron`, `routes`, `script`, `settings-schemas`, `mock-signature`, `test-helpers` |
| Content | `email-core` (`lang`/`dir`, footer identity without the ID number, LTR runs), `legal-content` (s.14C(a) elements, forbidden phrases, the ID number never in legal pages or the footer), `storefront` |
| Rules | `architecture` (`server-only` headers, `next/*` boundaries, no `@/server` in UI, `process.env` only in env files, logical CSS, `requireAdmin` in every admin page and route, `adminAction` wrappers, script imports), `check-secrets` (allowlist, hashed Cardcom name) |

### Contract (`tests/contract`)

Shared suites: `payment-provider.suite.ts` (mock, Cardcom fixtures, PayPal fixtures),
`taxdoc.suite.ts` (mock, Morning) and `carrier.suite.ts` (mock, DHL). They check required
fields, redirect extraction, every state mapped, minor units, idempotency headers,
`ProviderNotConfigured` paths, and that authentication accepts good input and rejects bad. Live
blocks are gated by `*_CONTRACT` and skip cleanly.

### Integration (`tests/integration`, real Postgres)

| File | What it proves |
|---|---|
| `schema-constraints` | a second active sale and a second winning attempt → 23505; reservation CHECKs; Israel ⇒ ILS; demo ⇒ not LIVE; totals CHECK; restrict on `reserved_by_order_id` |
| `reserve-race` | 20 dedicated clients released by a barrier → exactly one hold, no deadlocks, a lock wait observed; takeover after expiry; all-or-nothing for 2 items; caps under advisory locks; `client_request_id` resume |
| `finalize` | normal path; 10 concurrent finalizes → 1 sale; webhook ×3 plus the return route; late payment while the work is free → PAID; late payment after the work is gone → refund, receipt and credit note; duplicates; mismatches; config drift; stale quote → STALE_QUOTE refund; deferral during capture |
| `capture-race` | capture once under parallel finalize; capture timeout → re-entry with the same key; review → COMPLETED or DENIED |
| `refunds` | the cap (including unconfirmed FAILED); concurrent refunds; crash after the provider call → UNKNOWN with no second call; Cardcom non-zero → FAILED; our own PayPal refund webhook before the id is stored; MANUAL_REQUIRED → MANUAL_DONE |
| `webhook-replay` | a processing failure → 500 → redelivery; reconcile replays; reversal blocks fulfillment; forged requests never write; PayPal post-success events parsed by the real adapter |
| `cardcom-wiring` | over a fake Cardcom HTTP server: gateway documents end to end; the daily tail poll and live ListTransactions sweep (an unmatched transaction → CRITICAL); live providers refused while go-live blockers exist |
| `outbox-core`, `outbox-emails` | dedupe, SKIP LOCKED, backoff, lease, DEAD, email idempotency; commerce emails |
| `taxdocs` | marker search before re-issuing; gateway copy; `none`; patur credit notes; receipts for NEEDS_REFUND payments |
| `expire-job`, `reconcile-job` | hold release; in-flight attempts skipped; link expiry; the Cardcom watch window and tail; the sweep |
| `link-orders`, `requests`, `offline` | 48 h hold, re-quoting, expiry; questions, quotes and offers (Tier B); exact offline payments |
| `cancellations` | auto-match; double and web-then-phone notices both stored; the 4-month window; conversation detection; COMPLETED → CANCELLED; fee; EU; refund due from the notice; relist; masked acknowledgements |
| `cancellation-items` | per-work cancellation: the buyer preview (identity match, 2+ works); chosen works stored, duplicates only on overlap; a partial cancellation refunds the works only, keeps the order PAID, repacks the parcel (PACKED, LABEL_CREATED, PICKUP_SCHEDULED) with a smaller declared value and relists only that work; the shared ₪100 cap; shipping with the last work and CANCELLED only after it settles; defect → no fee; the admin narrowing the works; goodwill refund absorbed; zero refund; a work cancelled once (also under parallel accepts); per-work return and inspection (MIXED relist); schema constraints; the four new invariants; review payload v2 |
| `cart-checkout` | the N-item quote (per-item prices, one delivery, USD only when every work has it, named culprits, mixed demo refused, `maxCartItems`); the start (one hold and one attempt, price changes per item, a reserved or sold work named and nothing else held); per-artwork hold caps and the held-works cap; a paid cart sells every work; a lost work refunds the cart; partial-takeover cleanup; overlapping carts all-or-nothing |
| `shipments`, `tracking-job`, `daily-shipping` | manual transitions; the label claim and LABEL_UNKNOWN; export declaration; the cancellation block and override; collection needs the disclosure; customs lines in the declared currency; tracking advances monotonically; unshipped and export alerts; 30-day raw tracking purge |
| `daily-job`, `invariants`, `purge` | COMPLETED transitions, refund-deadline alerts, `admin-alert` emails; every invariant catches a broken row; retention |
| `disclosure-pdf` | the bilingual disclosure PDF is generated once and attached |
| `admin-catalog`, `admin-orders`, `admin-money` | artwork CRUD and publish checklist; Recheck payment and manual tracking; admin refunds, documents, dashboard cards |
| `storefront-queries`, `catalog-seed` | filters, sitemap and SEO reads; the catalog seed (fixtures) |
| `limits`, `transition`, `harness` | production rate limits and anti-hoarding caps; `transition()` and `withTx` retries; the test harness itself |

### E2E (`tests/e2e`, Playwright)

| Spec | Scenario |
|---|---|
| `smoke` (`@smoke`) | locale redirects, `html[dir][lang]`, demo banner, `X-Robots-Tag`; the cancel link on home, works, artwork, about, legal, contact, checkout and order pages; the admin guard |
| `storefront`, `storefront-minimal` | URL filters and sorts, "Sold" as text, the recently-sold strip, JSON-LD availability, the keyboard lightbox (arrows mirrored in he, Esc, focus return, live region), "insured" only when configured; `@mobile` sticky bar and scroll-snap |
| `checkout-minimal`, `purchase-il` | the bare checkout opens on step 1 (destination); full Israeli purchase through the three steps → Sold → emails with the disclosure PDF attachment → mock receipt → the admin sees the order; a pickup purchase types no street address |
| `checkout-steps` | the address-first steps with JavaScript off (pickup shows no street fields), "Change" keeps the values, postal code required in the US but not in Hong Kong, a carried method that isn't offered, the currency links, a blocked destination with the form prefilled, axe on every step in he and en |
| `race` | two browser contexts: one reaches payment, the other sees "just reserved" |
| `webhook`, `tamper` | "Pay without returning" → PAID; forged webhook → 401; duplicate webhooks → one sale; tampered amount → not paid plus a CRITICAL alert |
| `order-retry`, `late-payment`, `capture-mode` | cancel → retry → paid; release → available; late payments; capture and review modes |
| `international`, `shipping-rules` | US destination: a Latin city at step 1, the courier named "DHL Express" and priced by the estimate (the locked quote has `rateSource = DHL_ESTIMATE`), USD through the currency links, a Latin street address, DAP acknowledgement, USD total; blocked countries, GB low value, value cap, crate → quote only |
| `quote`, `offer`, `manual-order`, `contact` | quote → link → re-quote by switching to studio pickup → pay; offer through the artwork page → accept → pay, and auto-decline; manual order → exact transfer → PAID; the contact form |
| `cancellation-il` | the POST form with name and ID only, the ID never in the URL, review → confirm → acknowledgement and email with the ID masked, a resubmission as a possible duplicate, then the admin side: match, fee, refund, credit note, relist |
| `cancellation-partial` | a cart of three works paid by courier; the buyer unticks one on the review step; the admin sees the two ticked, the live preview (shipping kept, then refunded when the third is ticked), accepts; the refund settles with the order still PAID; relist → two AVAILABLE, one SOLD; the fulfillment page packs the third and names the cancelled works; axe on the review step in he and en |
| `cart` | add two works (header count), remove and re-add, one pickup checkout (through the steps, no street address) and one courier checkout in Hebrew, both Sold and the cart emptied; a work sold meanwhile named and left out, and "Remove from cart" keeps the destination and step; "Buy now" takes the work out of the cart; two buyers with overlapping carts; add and remove without JavaScript; axe on the cart and every cart checkout step |
| `fulfill` | a 5 MB packing photo upload, mock label, tracking cron → DELIVERED, printables, the label only through a signed URL, pickup blocked until the disclosure is confirmed |
| `admin-artwork`, `admin-offline`, `admin-auth` | create, upload, publish blocked until alt text is filled; an audited price change; offline hold and sale; 6 bad logins → 429; TOTP enrolment |
| `a11y`, `admin-a11y` | axe on home, works, artwork, checkout, cancel, order, admin login, the editor and the settings pages (including shipping), in he and en → zero serious or critical |
| `admin-shipping` | the DHL Express estimate group of the shipping settings: stored values, the tariff panel and DHL's links, in he and en |
| `not-found` | localized and global 404s |

**Not automated (spec §10.4 names them):** `headers`, `mobile` and `admin-security` specs do not
exist as separate files.
- The CSP and HSTS are covered by `tests/unit/csp.test.ts`, and were checked by hand with
  `curl` on a demo build and an `APP_ENV=production` build.
- Mobile layouts were checked from screenshots and a DOM overflow scan at 360 and 390 px.
- A forged session cookie on admin and `print/admin` routes, and the enroll-2fa no-loop, were
  probed by hand.

These are good follow-ups.

## Compliance coverage (WS6)

| Area | Tests |
|---|---|
| Deadlines and fee | `tests/unit/deadlines.test.ts`: 14 days from the later of delivery and disclosure; cancellation before delivery; 4 months only with eligibility **and** a conversation; refund due = notice + 14 days; DST; ₪1,500 → ₪75 and ₪20,000 → ₪100; EU and defect → 0; USD at the locked rate |
| Legal texts | `tests/unit/legal-content.test.ts`: the s.14C(a) elements in the pre-contract disclosure; forbidden phrases absent; the seller ID number never in legal pages or the footer |
| Cancellations | `tests/integration/cancellations.test.ts`: auto-match; double submissions and web-then-phone notices both stored; duplicates; the window, including 4 months; a conversation detected from a buyer request; COMPLETED order → CANCELLED; fee; EU; due date from the notice; relist; sealed review payload; masked acknowledgement emails |
| Invariants and go-live | `tests/integration/invariants.test.ts`: the demo seed with the three sample orders is consistent; every check catches a broken row |
| Retention | `tests/integration/purge.test.ts` |
| Daily job | `tests/integration/daily-job.test.ts`: COMPLETED transitions, refund-deadline alerts, `admin-alert` emails |
| Disclosure PDF (Tier B) | `tests/integration/disclosure-pdf.test.ts` |
| End to end | `tests/e2e/cancellation-il.spec.ts` |

## QA checklist (spec §10.6)

### Agent-verifiable (checked in M4 against a production build with a fresh demo database)

- [x] RTL mirroring: 220+ full-page Playwright screenshots in he and en at 390 and 1280 px,
      inspected. An automated DOM scan found no horizontal overflow at 360 or 390 px.
- [x] Prices, dimensions, phones, emails, and order and cancellation numbers are not mirrored
      (`<bdi dir="ltr">`). The Hebrew email footer's phone was split by the bidi algorithm; this
      was fixed in `c9288ae`. *Open, cosmetic:* the ₪ sign sits on different sides of the amount
      on the same Hebrew page: `<Price>` renders `8,900₪`, while plain-text amounts render
      `₪ 8,900`. This needs a design decision.
- [x] Keyboard-only checkout in he and en: from the skip link through details, consents and
      submit, then mock payment with Enter, reaching PAID. Every focus stop shows a visible focus
      ring.
- [x] Keyboard lightbox: opens with Enter, arrows follow the page direction, the live region
      announces the image, and Esc returns focus to the trigger. *Open, minor:* Tab is not
      trapped inside the lightbox.
- [ ] Keyboard-only pass on the other dialogs and on the cancellation form. Its review and
      confirm steps are plain POST buttons that work without JavaScript, covered by
      `cancellation-il.spec.ts`, but no separate keyboard-only pass was done.
- [x] axe in both locales: `a11y.spec.ts` and `admin-a11y.spec.ts` report zero serious or
      critical issues.
- [x] A4 print output of every printable through `page.pdf()`: 16 PDFs inspected (disclosure for
      IL and US, mock receipt, packing slip for IL and US, commercial invoice, COA, studio notice;
      he and en). The commercial invoice's line values were fixed in `f3a2a49`. *Open, minor:*
      no `@page` margin, so `page.pdf()` output runs edge to edge (browser printing adds
      margins).
- [x] Emails in he and en from `email_messages`, 19 rendered: order confirmation, painter new
      order, receipt, cancellation acknowledgement, painter cancellation. The disclosure PDF
      attachment is asserted in `purchase-il.spec.ts`.
- [x] Reduced-motion emulation: no transitions and no smooth scrolling.
- [ ] Lighthouse: not run headless here; moved to the user items.

### For the user or the painter

- [ ] VoiceOver in he and en.
- [ ] The artwork editor on a real phone, uploading from the camera roll.
- [ ] 200% zoom.
- [ ] Lighthouse on a real device.
- [ ] Final legal and visual sign-off.

### Minor findings left open (M4 QA)

- The admin order page shows the raw status code next to the translated badge. Its timeline
  shows raw audit action keys and email template ids. Alerts show their kind codes. This is
  deliberate technical detail.
- The mock payment page shows the raw flow and state values (`DIRECT` / `OPEN`).
- The buyer's order page shows payment attempt times without a date.
- The settings hint shows the insurance cap without a thousands separator.
- A few block links are 20 px tall, below the 24 px WCAG 2.2 target unless their spacing exempts
  them: "Back to the work" on checkout, "Read the full privacy policy" on cancel and contact, and
  the dashboard card links.
- Demo data: the placeholder Hebrew legal name `(למילוי)` appears on English documents, and the
  COA signature reads "(to be completed)".
