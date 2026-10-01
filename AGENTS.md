<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Geula Gallery: project rules for agents (spec §9.6)

The authoritative plan is `docs/implementation-spec.md`; running notes, deviations and gotchas
are in `docs/architecture.md` ("Implementation notes"). Read both before changing code.

## Commands
- First run: `npm ci && npm run env:init && npm run db:setup && npm run db:reset && npm run dev`.
- Checks: `npm run lint` (biome) · `npm run typecheck` · `npm run check:secrets` ·
  `npm test` (unit + contract) · `npm run test:integration` (real Postgres, TEST_DATABASE_URL) ·
  `npm run test:e2e [-- <playwright args>]` (own server on E2E_PORT, `.next-e2e`).
- `npm run verify` = lint + typecheck + check:secrets + test + test:integration;
  `npm run verify:all` = verify + build + test:e2e. Every commit passes lint and typecheck.
- DB: `db:setup`, `db:migrate`, `db:reset -- [--db <name>] [--seed demo|none] --yes`, `db:seed`.
  `db:generate` and `drizzle/**` are integrator-only.
- Cron: `npm run cron -- <job> [--watch]` calls `GET /api/cron/<job>` over HTTP (needs a running
  server). Scripts never import jobs, the outbox processor, rendering code or `src/server/next`.

## Ownership (spec §9.2–9.4)
- Frozen after M1: package.json + lockfile (change requests only), `next.config.ts`,
  `src/proxy.ts`, the root layout, `src/i18n/*`, `src/server/env.ts`, `globals.css` tokens, this
  file, `src/server/db/schema/**` + `drizzle/**` (schema-change requests), the §9.3 contracts,
  `tests/helpers/{db,mock-webhook,mailbox,totp,race}.ts` and `tests/helpers/factories/core.ts`.
- Streams own only their listed paths: WS1 storefront/SEO, WS2 commerce core, WS3 shipping and
  fulfillment, WS4 admin and requests, WS5 integrations, WS6 compliance and documents. Each stream
  adds its own `tests/helpers/factories/<stream>.ts`, E2E specs and message files.
- `components/ui/*`: new files allowed, no edits. Registries (outbox handlers, jobs, email
  templates, adapters, seed modules, admin nav) exist since M1; fill your stub, do not edit maps.

## Principles (spec §1.1)
- Postgres decides money and inventory: conditional UPDATEs with row counts checked, partial
  unique indexes (one active sale per artwork, one winning attempt per order), CHECKs. Caches,
  timers, sweepers and webhooks never decide state.
- **Lock order: artworks (ORDER BY id) → per-buyer advisory xact locks → orders (ORDER BY id) →
  payment_attempts → refunds.** Lock every row an FK insert will reference `FOR UPDATE` *before*
  the insert. Only `pg_advisory_xact_lock` (never session advisory locks). Use `withTx` (retries
  40P01/40001) and always `tx` inside it. Never call a provider inside a DB transaction.
- One idempotent `finalizeAttempt()`; a claim row before every provider call; timeouts become
  UNKNOWN and are reconciled (query first) before any retry.
- Redirect-only payments (SAQ-A): no third-party scripts on our pages.
- Fully dynamic rendering; data functions take `locale` explicitly.
- Money is integer minor units + currency; lengths mm, weights g; never trust client totals
  (amounts come from the DB and the quote version).

## Code rules (enforced by `tests/unit/architecture.test.ts`)
- Every file in `src/server/**` except `auth/options.ts` starts with `import "server-only"`.
- Domain services never import `next/*`, `next-intl` or `better-auth/next-js`; request-time Next
  APIs live in `src/app/**` and `src/server/next/**` only. UI code (`components`, `emails`,
  `content`, `lib`) never imports `@/server`.
- `process.env` is read only in `src/server/env.ts` and `src/lib/public-env.ts`.
- Logical CSS only: no `ml-/mr-/pl-/pr-/left-/right-/start-/end-/text-left/text-right`; use
  `ms-/me-/ps-/pe-/inset-s-/text-start/text-end`.
- `requireAdmin()` in every admin page, print/admin page, action and route (layouts and the
  proxy are never enough); admin `actions.ts` exports are all wrapped by `adminAction`.
- Every Server Action and route input carries `locale`. Never wrap `redirect()`/`notFound()` in
  try/catch.

## Secrets, PII and git
- The repo is public. No secrets or PII in commits: `.env.local` only; `.env.example` holds
  placeholders; fixtures are anonymised; test values start with `e2e-`/`test-`/`dev-only-`;
  emails `@example.com`/`@example.test`, phones `03-000-0000`/`+972-3-000-0000`, ID `000000018`.
  Run `npm run check:secrets` before committing.
- Conventional Commits, each ending with a blank line and
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or rewrite history
  without the user.
- Never print or `Read` whole files under `src/server/integrations/generated/` or `openapi/`
  (large third-party content); use `grep -n` with small context.
- This folder may be synced by a file-sync service that creates `"<name> 2"` duplicates
  (including in `.git` and `node_modules`); check `git diff --cached --name-status` before
  committing and delete stray duplicates.
