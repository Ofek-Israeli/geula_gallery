# Geula Gallery

A bilingual online gallery and shop (Hebrew RTL by default, English LTR) where one Israel-based
painter shows and sells her original paintings. Every work is unique, with quantity 1. Once a
work is bought it shows "Sold", and the database makes a second sale impossible.

One Next.js app and one PostgreSQL database run four things:

1. **The public gallery and shop:** the works grid, artwork pages with a lightbox, checkout with
   a 35-minute hold, order pages, quote and offer requests, the contact form and the legal pages.
2. **A Hebrew-first, mobile-friendly admin:** dashboard, artworks, orders and fulfillment,
   inbox, cancellations, alerts and settings. TOTP 2FA is required on any https deployment.
3. **Real provider integrations, each behind an interface with a mock:**
   - payments: Cardcom (primary) and PayPal (secondary);
   - tax documents: Morning (Green Invoice) or Cardcom gateway documents;
   - shipping: DHL Express MyDHL, a manual carrier, and a table-rate engine the painter edits;
   - email: Resend.
4. **The Israeli consumer-law flows:** the pre-contract disclosure, the cancellation form,
   refund deadlines and data retention.

> **Status:** v1 is on the `feat/gallery-v1` branch and in review. The full plan is in
> [`docs/implementation-spec.md`](docs/implementation-spec.md). Nothing has been deployed yet.

## Stack

| Area | Choice (exact pins are in `package.json`) |
|---|---|
| Framework | Next.js 16.3.8 (App Router, `force-dynamic`), React 19.3, TypeScript 5.9 (strict) |
| i18n | next-intl 4.14.8 (`/he` is the default, plus `/en`); `use-intl/core` for emails and documents |
| Database | PostgreSQL 18; Drizzle ORM 0.45.3 (core query builder) over `pg` |
| Auth | Better Auth 1.7.7: email and password, TOTP 2FA, rate limits stored in the database |
| Styling | Tailwind CSS 4.3, logical properties only (RTL-safe) |
| Images | sharp 0.35 (ICC-aware); local storage, or Vercel Blob with a public and a private store |
| Email | react-email 6.11 and Resend 6.31 (a log driver locally) |
| PDF | @react-pdf/renderer 4.9.0 for the bilingual disclosure PDF |
| Providers | openapi-fetch 0.17, with types generated from each provider's OpenAPI document |
| Validation | zod 4.6 |
| Quality | Biome 2.5; Vitest 5 (unit, contract, and integration on a real Postgres); Playwright 1.63 with axe |

## Prerequisites

- **macOS with Homebrew.** Other platforms work as long as PostgreSQL 18 runs on
  `localhost:5432`.
- **Node.js 24.x**, the Vercel runtime. Newer versions also work. Development used Node 26.7,
  where npm prints an `EBADENGINE` warning that you can ignore.
- **PostgreSQL 18 from Homebrew**, with trust authentication for your macOS user:

  ```bash
  brew install postgresql@18 && brew services start postgresql@18
  # Recommended: room for the test suites and several dev servers at once.
  /opt/homebrew/opt/postgresql@18/bin/psql -d postgres -c "ALTER SYSTEM SET max_connections = 200"
  brew services restart postgresql@18
  ```

  **About `max_connections`:** on the development machine it was raised from the default of 100
  to 200 with the command above. This changes only the local Postgres server. If you keep the
  default, run the integration suites one after another, not in parallel. To undo it, run
  `/opt/homebrew/opt/postgresql@18/bin/psql -d postgres -c "ALTER SYSTEM RESET max_connections"`
  and restart the service.
- **Chromium for Playwright** (E2E tests only): `npx playwright install chromium`.

## Quick start

```bash
npm ci && npm run env:init && npm run db:setup && npm run db:reset && npm run dev
```

- `env:init` writes `.env.local` with freshly generated secrets, the local database URLs
  (`geula_dev`, `geula_test`, `geula_e2e`), mock providers, the log email driver and local
  storage. It never overwrites an existing file; `-- --force` regenerates it.
- `db:setup` creates the three local databases. It refuses any host other than localhost.
- `db:reset` drops, migrates and seeds `geula_dev` with the demo catalog: 16 works, 3 sample
  orders, a placeholder business profile and the painter's account.
- Open <http://localhost:3000>. It redirects to `/he` or `/en` based on your browser language.

**Admin login:** go to <http://localhost:3000/he/admin>. The email is `ADMIN_EMAIL`
(`painter@example.com`) and the password is `ADMIN_PASSWORD`, both from `.env.local`. The
password is generated and never printed, so read it from the file. `npm run admin:create`
creates the account from the same values; it is idempotent by email. 2FA is optional locally
(`ADMIN_REQUIRE_2FA=false`) and forced on https.

**Background jobs:** in production, Vercel Cron calls `/api/cron/<job>`. Locally, the cron
script calls the same route over HTTP, so a server must be running (`npm run dev` or
`npm start`):

```bash
npm run cron -- outbox      # run one job now (reconcile | outbox | tracking | daily | purge)
npm run cron -- --watch     # every minute, run the jobs whose vercel.json schedule matches
```

The app also processes the outbox right after each request (`after()`), so most local flows
need no cron at all.

## Scripts

| Script | What it does |
|---|---|
| `dev`, `build`, `start` | Next.js |
| `lint`, `format` | Biome check and format |
| `typecheck` | `next typegen && tsc --noEmit` |
| `check:secrets` | scans the working tree for secrets and PII; `-- --stdin` scans a patch stream such as `git log -p` |
| `test` | Vitest `unit` and `contract` projects (no database) |
| `test:unit`, `test:contract` | one Vitest project each |
| `test:integration` | Vitest on a real Postgres (`TEST_DATABASE_URL`, re-migrated on every run) |
| `test:e2e [-- <playwright args>]` | resets `geula_e2e`, builds into `.next-e2e`, serves on `E2E_PORT` (3100) and runs Playwright |
| `verify` | lint + typecheck + check:secrets + test + test:integration |
| `verify:all` | verify + build + test:e2e |
| `db:setup` | creates the local databases |
| `db:migrate` | applies `drizzle/*.sql`, using `DATABASE_URL_UNPOOLED` |
| `db:reset -- [--db <name>] [--seed demo\|none] --yes` | drops, migrates and seeds a database |
| `db:seed` | runs the idempotent seed modules |
| `db:generate` | generates a migration from the schema (integrator only) |
| `admin:create` | creates the painter's account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` |
| `env:init` | writes `.env.local` |
| `cron -- <job> [--watch]` | calls a cron job over HTTP |
| `demo:fetch-images` | re-downloads the AIC demo images (the output is already committed) |
| `gen:api-types` | regenerates the provider types from `openapi/` (for DHL, from the current MyDHL spec) |
| `check:cardcom`, `check:paypal`, `check:morning`, `check:dhl` | opt-in live sandbox checks; each exits 0 and skips cleanly without credentials |

[`docs/testing.md`](docs/testing.md) has the test inventory and the QA checklist.

## Provider modes: what is real and what is mocked

Everything runs locally against **mocks**. Each real adapter is built from the provider's
OpenAPI document, is tested against recorded or synthetic fixtures, and is switched on through
environment variables.

| Area | Variable | Local default | Real options | Status in v1 |
|---|---|---|---|---|
| Payments | `PAYMENT_PROVIDERS` | `mock`: a hosted mock page with HMAC-signed webhooks and capture and review modes | `cardcom`, `paypal` | See the Cardcom and PayPal rows. |
| Cardcom | `CARDCOM_MODE` | `disabled` | `test`, `live` | Fixture-tested. The public test terminal now refuses its published credentials (HTTP 401, ResponseCode 603), so a live check needs a real test terminal. `live` also needs `CARDCOM_API_PASSWORD` for refunds, the daily sweep and gateway documents. |
| PayPal | `PAYPAL_MODE` | `disabled` | `sandbox`, `live` | Fixture-tested; waiting for sandbox credentials (client id and secret, webhook id, merchant id). |
| Tax documents | `TAX_DOCUMENTS_MODE` | `mock` | `morning`, `gateway`, `none` | |
| Morning | `MORNING_MODE` | `disabled` | `sandbox`, `live` | Fixture-tested; waiting for sandbox keys. |
| Carrier | `SHIPPING_CARRIER` | `mock`: moves to DELIVERED after `MOCK_CARRIER_DELIVERY_SECONDS` | `manual`, `dhl` | |
| DHL | `DHL_EXPRESS_MODE` | `disabled` | `test`, `live` | Built on the MyDHL 3.3.2 types; tested with fixtures and contract tests. `api-mock.dhl.com` answered a read-only probe. A live check needs an account. |
| Email | `EMAIL_DRIVER` | `log`: rendered emails are stored in `email_messages` | `resend` | |
| Storage | `STORAGE_DRIVER` | `local`: `.data/uploads/{public,private}` | `blob` | |

These safety rails hold in every mode:

- A live provider can never charge a demo work. A registry rule and a DB CHECK both enforce
  this.
- A live provider is refused while any go-live blocker exists. The blockers are listed on the
  dashboard and come from `src/server/golive.ts`.
- In production, the mock provider is accepted only for demo items.

### Environment overview

`src/server/env.ts` validates every variable at boot, including the rules that span several
variables, so a bad configuration fails fast instead of misbehaving.
[`.env.example`](.env.example) lists every variable with a placeholder and a comment.
`PUBLIC_WEBHOOK_BASE_URL` and `BETTER_AUTH_URL` default to `APP_URL`. Production values are in
[`docs/deploy.md`](docs/deploy.md).

## Architecture map

```
src/proxy.ts                     locale routing plus an early admin-cookie redirect (never the only check)
src/app/[locale]/(site)/         public pages: home, works, artwork, about, contact, credits, legal, cancel, orders
src/app/[locale]/(checkout)/     checkout and the mock payment page (minimal chrome, noindex)
src/app/[locale]/(print)/print/  printables: disclosure and receipt; admin/ has the packing slip, commercial invoice, COA, studio notice
src/app/[locale]/admin/          admin (requireAdmin() in every page, action and route)
src/app/api/                     auth, payments/[provider]/{webhook,return}, cron/[job], files, admin uploads, health
src/server/                      domain services (server-only; never import next/*)
  checkout/ payments/ taxdocs/ shipping/ orders/ cancellations/ requests/ catalog/ admin/
  outbox/ jobs/ email/ documents/ storage/ media/ security/ auth/ settings/ db/ integrations/
  next/                          the thin Next layer: guards, after(), revalidation
src/lib/                         pure, isomorphic utilities: money, VAT, deadlines, Israeli ID, phone
src/components/ src/emails/ src/content/   UI, email templates, legal and disclosure texts (never import @/server)
scripts/                         CLI scripts: env, db, seed, cron over HTTP, live checks, secret scan
tests/{unit,contract,integration,e2e}/
```

The main principles:

- **Postgres decides money and inventory.** Every conditional UPDATE has its row count checked.
  Partial unique indexes allow one active sale per artwork and one winning payment per order.
  Locks are taken in one global order.
- **One idempotent `finalizeAttempt()`** serves webhooks, return redirects, the reconcile job
  and the admin's "Recheck payment" button.
- **A claim row is written before every external call.** A timeout becomes UNKNOWN and is
  queried again; it is never retried blindly.
- **Payments are redirect-only (PCI SAQ-A):** no third-party scripts run on our pages.

[`docs/architecture.md`](docs/architecture.md) has the layers, state machines, failure modes
and implementation notes.

## Documentation

| Document | For |
|---|---|
| [`docs/implementation-spec.md`](docs/implementation-spec.md) | the authoritative v1 plan |
| [`docs/architecture.md`](docs/architecture.md) | layers, state machines, failure modes, implementation notes |
| [`docs/testing.md`](docs/testing.md) | commands, test inventory, QA checklist |
| [`docs/deploy.md`](docs/deploy.md) | Vercel Pro, Neon, Blob, Resend, the environment matrix, the go-live checklist |
| [`docs/painter-onboarding.md`](docs/painter-onboarding.md) | the painter, her accountant and her lawyer (Hebrew first) |

## Demo content and credits

The demo catalog uses **16 public-domain (CC0) paintings from the
[Art Institute of Chicago](https://www.artic.edu/open-access)**, downloaded through the AIC API.
The artists are Marsden Hartley, Félix Vallotton, Paula Modersohn-Becker, Lilla Cabot Perry,
Henri Edmond Cross, Paul Sérusier, Arthur Wesley Dow, John Henry Twachtman, George Inness, Paul
Camille Guigou, Edward Henry Potthast, Maurice Prendergast and Vilhelm Hammershøi. Each work's
title, date and credit line are in `data/demo-manifest.json` and on the site's `/credits` page.
In demo mode the prices, sales and business details are fictitious, and a banner on every page
says so.

Fonts: Frank Ruhl Libre and Assistant, under the SIL Open Font License (`assets/fonts/OFL.txt`).

## Not yet (deliberately deferred)

- **Rendering:** Cache Components / PPR. Data functions already take `locale` explicitly, so
  this can be adopted later.
- **A cart UI.** The schema and the reservation SQL already handle several items per order.
- **Advertising email**, such as a newsletter or "notify me". Under s.30A these count as
  advertising, so sold or held works offer a one-to-one inquiry instead.
- **EU sales:** EUR prices and EU targeting (GPSR). The EUROPE zone exists but is disabled and
  routes buyers to a quote.
- **Shipping extras:** DHL live rates and landed cost, DDP, the DHL Unified Tracking API,
  domestic courier APIs, and the DHL "Request pickup" button (the adapter method exists).
- **Payment extras:** the Cardcom iframe, J5 authorise-then-capture, the PayPal JS SDK and
  disputes API, and other payment providers. Today a PayPal dispute raises an alert and blocks
  fulfillment.
- **Admin extras:** Blob client uploads for large photos, a live preview, `/admin/series` and a
  `site_content` editor.
- **Other:** analytics, "view on a wall", carousels, buyer accounts, Vercel WAF and BotID, CI on
  GitHub Actions, and the deployment itself.

## Legal disclaimer

The legal texts in this repository are **drafts**, and a lawyer must review them before any real
sale. They are the terms, returns and cancellation, shipping and duties, privacy, the
accessibility statement, the pre-contract disclosure, the studio notice and the certificate of
authenticity. The tax-document settings are also drafts for an accountant to review: document
types, VAT treatment, receipts for refunded payments, export evidence and retention periods.
[`docs/painter-onboarding.md`](docs/painter-onboarding.md) lists the open questions. Nothing in
this repository is legal or tax advice.

## Security policy

This repository is **public**.

- **Never commit** secrets, API keys, `.env*` files, `.data/`, customer data, or the business's
  identity details. The one exception is `.env.example`, which holds placeholders only.
  Credentials live only in your local `.env.local` and in the hosting provider's environment
  variables. The business profile (legal name, ID number, addresses) is stored in the database,
  not in the code.
- Test data is anonymised. Emails use `@example.com` or `@example.test`, phones are
  `03-000-0000`, and the ID number is the checksum-valid `000000018`.
- Run `npm run check:secrets` before every commit. To scan the full history, run
  `git log -p --all --format= | npm run check:secrets -- --stdin`.
- The repository should have Dependabot security updates and secret-scanning push protection
  turned on (Settings → Code security).
- **Reporting a vulnerability:** do not open a public issue. Use GitHub's private vulnerability
  reporting on this repository (Security → Report a vulnerability) or contact the owner directly.
- **If a secret leaks:** first rotate it at the provider and in Vercel, then clean up. The
  runbook is in [`docs/painter-onboarding.md`](docs/painter-onboarding.md). Rewriting git
  history does not undo the leak of a secret that was already pushed.
