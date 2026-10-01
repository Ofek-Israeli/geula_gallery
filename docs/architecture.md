# Architecture

The authoritative design is [`docs/implementation-spec.md`](./implementation-spec.md). This file
grows into the layer, state-machine and failure-mode reference during M1–M4 (spec §11.4). Until
then, the section that matters most to later agents is **Implementation notes** below.

## Layers (summary of spec §2.2)

| Layer | Path | Notes |
|---|---|---|
| Next layer | `src/app/**`, `src/server/next/**` | the only place for `next/*` and `better-auth/next-js` |
| Domain services | `src/server/**` | `import "server-only"` first; never `next/*` (biome `noRestrictedImports`) |
| Auth options | `src/server/auth/options.ts` | pure factory; no `server-only`, no `next/*`, no `process.env` |
| Isomorphic | `src/lib/**` | pure code; never `@/server` |
| UI | `src/components/**`, `src/emails/**`, `src/content/**` | never `@/server` |
| Scripts | `scripts/**` | run with `node --conditions=react-server --env-file-if-exists=.env.local --import tsx`; never import jobs, the outbox processor or rendering code |

## Database

- Schema: `src/server/db/schema/{enums,columns,auth,catalog,commerce,compliance,shipping,ops}.ts`,
  re-exported by `index.ts`. Integrator-only after `contracts-v1`.
- Migrations: `npm run db:generate` → `drizzle/NNNN_*.sql` (committed). Applied by
  `scripts/db-migrate.ts` / `scripts/db-reset.ts` with the drizzle node-postgres migrator
  (migrations table in schema `drizzle`).
- Client: `src/server/db/client.ts` (one `pg.Pool`, `casing: "snake_case"`, core query builder).
- Seeds: `scripts/seed/index.ts` registry `[settings, catalog, orders, users]`.

## Implementation notes

Running log of deviations from the spec, spike results and gotchas. Newest milestone last.

### M1 steps 2–6 (scaffold, dependencies, config, env, schema)

**Versions and tooling**
- All spec §9.1 step 3 versions installed exactly as listed (no substitutions needed).
- `npm audit` reports 4 moderate advisories, all from `drizzle-kit@0.31.11`'s bundled
  `@esbuild-kit/*` → old `esbuild` (dev-only, dev-server CORS advisory). Not fixable without a
  drizzle-kit downgrade; accepted (dev dependency, never served).
- npm 11.19 `allowScripts`: install scripts for `esbuild`, `@swc/core` and `@parcel/watcher` are not
  run. Not needed: esbuild/tsx/sharp work from their prebuilt optional packages; `@swc/core` and
  `@parcel/watcher` are only used by next-intl's message-extraction tooling, which we do not use.
- `engines.node` is `24.x` (Vercel target) while the local machine runs Node 26.7 → npm prints an
  `EBADENGINE` warning on install. Harmless (`engine-strict` is off).
- `package.json` has `"type": "module"`: scripts use top-level `await` (tsx refuses TLA in CJS), and
  the Better Auth CLI warned about typeless packages. `next.config.ts`, `postcss.config.mjs`,
  drizzle-kit and Vitest all work with it.
- `npx playwright install chromium` was run (browser cache outside the repo).

**Scaffold**
- create-next-app 16.3.8 (`--empty --agents-md --biome`) was generated in the scratchpad and
  rsynced (excluding README.md, .gitignore, next-env.d.ts); `src/app/layout.tsx` and `page.tsx`
  were deleted, so the app currently has **no routes** (M1 step 7 adds `[locale]/layout.tsx`).
  `next build` is therefore not expected to pass until step 7.
- The template `.gitignore` lines were merged into ours; `openapi/` and `.next*/` added per §7.
- `src/i18n/routing.ts` and `src/i18n/request.ts` are **minimal placeholders** created in step 4:
  the next-intl plugin in `next.config.ts` throws at config load ("Could not locate request
  configuration module") when `request.ts` is missing, which breaks `next typegen`. Step 7 owns
  and completes them (messages from `namespaces.ts`, navigation, proxy).

**npm scripts (§10.7)**
- Every script exists. Not-yet-implemented ones point at their final script path, which is a stub
  that prints a notice and exits 0 (`scripts/lib/not-implemented.ts`): `check:secrets` (step 14),
  `gen:api-types` (step 12), `cron` (step 11), `demo:fetch-images` (M2), `check:{cardcom,paypal,
  morning,dhl}` (WS5). Replacing the stub file body is enough; package.json need not change.
- `test:e2e` points at `scripts/test-e2e.ts` (stub) until step 14 adds `playwright.config.ts`;
  step 14 should change the script to `playwright test`.
- `test`, `test:contract`, `test:integration` are real Vitest commands. A minimal
  `vitest.config.ts` (three projects, `@` and `server-only` aliases, `passWithNoTests`) exists so
  they exit 0 today; step 14 adds the integration `globalSetup`, truncation and helpers.
- Extra scripts beyond §10.7: `test:unit`, `format`, `auth:generate`.

**Config**
- `next.config.ts` exports a phase function: `'unsafe-eval'` and `ws:` are added to the CSP only
  for `PHASE_DEVELOPMENT_SERVER` (Next dev needs them); HSTS and `upgrade-insecure-requests` only
  when `APP_ENV=production`; `X-Robots-Tag: noindex, nofollow` on every route when
  `DEMO_MODE=true`. These env reads happen at build time. `globalNotFound` and
  `serverActions.bodySizeLimit` live under `experimental` in Next 16.3.8.
- `outputFileTracingIncludes` uses the all-routes key `'/*'` (verified: Next matches keys with
  picomatch `{ contains: true }`), value `./assets/fonts/**/*`.
- Token pages (`/:locale/orders/**`, `/:locale/print/**`) get `Referrer-Policy: no-referrer`;
  `/:locale/admin/**` gets `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store`.
- `biome.json`: `noRestrictedImports` overrides per layer (verified to fire). `files.includes`
  force-ignores generated code, `drizzle`, `data`, `openapi`, `.data`, `.next*`.

**Environment (`src/server/env.ts`)**
- `parseEnv(source)` is pure (unit-testable); `env` is parsed at import, and
  `src/instrumentation.ts` imports it so a bad config fails at boot. Errors list variable names
  and reasons, never values.
- Empty strings are treated as unset (so `.env.local` lines like `PAYPAL_CLIENT_ID=` are fine).
- Choices where the spec was silent: `PAYMENT_PROVIDERS` is a comma list of `mock|cardcom|paypal`
  (default `mock`); `MOCK_PAYMENT_FLOW` is `direct|capture`; `PAYPAL_MODE`/`MORNING_MODE` are
  `disabled|sandbox|live`, `CARDCOM_MODE`/`DHL_EXPRESS_MODE` are `disabled|test|live`;
  `CARDCOM_WALLETS` ⊆ `bit,applepay,googlepay`; `CARDCOM_3DS` ∈ `Enabled|Disabled|Auto`;
  `MOCK_CARRIER_DELIVERY_SECONDS` default 300; `PII_ENCRYPTION_KEY` must be base64/base64url of
  exactly 32 bytes (exposed decoded as `env.PII_ENCRYPTION_KEY_BYTES`).
- Secrets: `APP_SECRET` and `BETTER_AUTH_SECRET` ≥ 32 chars always; `CRON_SECRET` and
  `MOCK_WEBHOOK_SECRET` ≥ 16 outside production, ≥ 32 in production.
- Extra cross-field rules beyond §4.8 (all "obviously broken config" guards): a provider listed
  in `PAYMENT_PROVIDERS` must have its mode enabled; enabled Cardcom needs terminal + API name;
  `TAX_DOCUMENTS_MODE=gateway` requires `CARDCOM_MODE=live` (stricter than the spec's
  "test ⇒ not gateway", which it implies); `morning` docs need `MORNING_MODE` + credentials;
  `SHIPPING_CARRIER=dhl` needs `DHL_EXPRESS_MODE` + credentials; resend/blob drivers need their
  tokens; production forces `RATE_LIMIT_SCALE=1` and `FORM_MIN_AGE_MS ≥ 3000` even in demo mode.
- `ADMIN_PASSWORD` is intentionally not part of `env` (scripts only).

**`env:init` and the Cardcom test terminal**
- The public test-terminal values must not appear in committed files (spec §7; `check-secrets`
  will flag the API name by hash), and that includes `scripts/env-init.ts` itself. So env-init
  takes them from the invoking shell — `CARDCOM_TEST_TERMINAL_NUMBER=… CARDCOM_TEST_API_NAME=…
  npm run env:init` (or `-- --cardcom-terminal=… --cardcom-api-name=…`) — and otherwise writes the
  `CARDCOM_*` values empty. `CARDCOM_MODE=disabled` either way. The M1 run supplied them, so the
  local `.env.local` has them.
- env-init refuses to overwrite an existing `.env.local` unless `-- --force`; writes it `0600`;
  sets `DEMO_MODE=true`, `ADMIN_EMAIL=painter@example.com` and a generated `ADMIN_PASSWORD`
  (never printed).

**Schema (§3)**
- All §3.2 enums and §3.3 tables, CHECKs, partial unique indexes and indexes are implemented in
  one migration `drizzle/0000_init.sql`. Verified by hand in psql: inventory number default
  (`A-2026-001`), slug CHECK, IL ⇒ ILS, total sum, demo ⇒ not LIVE, the winner index, the
  one-active-sale index, the reservation-pair CHECK and the `reserved_by_order_id` RESTRICT FK.
  (The automated `schema-constraints` integration test is M1 step 14.)
- `casing: "snake_case"` is set in both `drizzle.config.ts` and every drizzle client, so TS keys
  are camelCase and SQL names snake_case. Constraint/index names are explicit snake_case.
- Fixed vocabularies stored as `text` + CHECK (not Postgres enums): `orders.status_reason`,
  `orders.fulfillment_blocked_reason`, `orders.conversation_source` (regex), `buyer_requests.topic`,
  `mock_payments.flow/state`, `email_messages.status` (`PENDING|SENT|FAILED`, our choice),
  `settings.key`. The value lists are exported from `schema/enums.ts`.
- Choices where the spec was silent (all nullable unless stated): `artworks.description_*` and
  `artwork_images.alt_*` are `NOT NULL DEFAULT ''` (alt text is enforced by the publish
  checklist, not the DB, because an upload creates the row before the alt text exists);
  `artworks.packaging_type` defaults to `STRETCHED_BOX`; `orientation`/`size_bucket` are
  `NOT NULL` and computed by the app; `mock_payments` has a uuid `id` plus unique `ref`;
  `shipment_events.code` is `NOT NULL DEFAULT ''` because it is part of the dedupe key;
  `shipments.idempotency_key` is `uuid`; `tax_documents.doc_type_code` is `integer`;
  `generated_documents.version` is `text`.
- Extra CHECKs beyond the spec (defensive, all consistent with §3.6): non-negative amounts and
  counters everywhere; `payment_attempts.seq BETWEEN 1 AND 5` (the ≤ 5 rule); credit notes need
  `refund_id`, receipts need `attempt_id`; `refunds` MANUAL_DONE needs `manual_reference`;
  REJECTED cancellations need `decision_reason`; a cancellation needs an ID number, an order
  number input or a matched order; `generated_documents` needs an order or a sale;
  `mock_payments.refunded_minor ≤ amount_minor`; `orders.ship_country ~ '^[A-Z]{2}$'`.
- `orders.paid_attempt_id → payment_attempts`, `artworks.reserved_by_order_id → orders`,
  `refunds.cancellation_id ↔ cancellations.refund_id` and `cancellations.duplicate_of_id` are
  cyclic and written with `(): AnyPgColumn => …`. Every FK to `orders` is `ON DELETE RESTRICT`.
- `audit_log` and `outbox_jobs` use `bigint GENERATED ALWAYS AS IDENTITY` (mode `number`).

**Better Auth**
- `npx auth@1.7.7 generate` works with the drizzle adapter (flags: `--config`, `--output`,
  `--yes`; `--adapter/--dialect` exist but are unnecessary). It is wrapped by
  `npm run auth:generate` (`scripts/auth-generate.ts`), which post-processes the output: prepends
  `import "server-only"`, converts every `timestamp(...)` to `timestamptz`, runs biome. The CLI
  logs a harmless "Drizzle schema mismatch / Missing tables" error because `scripts/auth-cli.ts`
  passes no schema object.
- Generated tables: `user`, `session`, `account`, `verification`, `two_factor` (with
  `failed_verification_count` / `locked_until` in 1.7.7), `rate_limit`. Ids are Better Auth text
  ids. The CLI also emits drizzle `relations()`; they are harmless and kept as generated.
- `createAuthOptions({ db, schema?, secret, baseURL, allowSignUp?, hooks? })` returns the options
  object (`satisfies BetterAuthOptions`) with `twoFactor({ issuer: 'Geula Gallery' })` as the only
  plugin. The Next layer (step 9) should spread it and append `nextCookies()` last
  (`plugins: [...opts.plugins, nextCookies()]`) to keep plugin type inference.
- `admin:create` / the `users` seed build a script-local `betterAuth` with sign-up enabled and
  `autoSignIn: false` (no session row), call `auth.api.signUpEmail`, then mark the email verified.
  Idempotent by email (case-insensitive); refuses a fourth user. The fallback via
  `internalAdapter` was not needed.

**DB scripts and seeds**
- `db:setup` creates the DBs named by `DATABASE_URL`/`TEST_DATABASE_URL`/`E2E_DATABASE_URL`
  (defaults `geula_test`/`geula_e2e`) plus any `--db <name>`; refuses non-localhost.
- `db:migrate` uses `DATABASE_URL_UNPOOLED ?? DATABASE_URL` and is allowed against remote hosts
  (deploy build), but `--db` only for local hosts. `db:reset` and `db:seed` refuse non-localhost.
- Seeds receive their own drizzle instance (dedicated `pg.Client`, `--db` aware) and never import
  `src/server/db/client.ts` or `src/server/env.ts`.
- Seed modes: `none` = baseline config only (`settings`); `demo` (default) = settings, catalog,
  orders, users. Settings rows are inserted with `ON CONFLICT DO NOTHING`, so re-seeding never
  overwrites the painter's edits (use `db:reset` for a clean slate).
- `catalog.ts` and `orders.ts` are stubs that log and return (M2 / WS6).
- `users` seed: painter from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (skipped with a message if unset);
  with `SEED_E2E_USERS=true` also `e2e-admin@example.test` and `e2e-2fa@example.test` with password
  `E2E_ADMIN_PASSWORD ?? "e2e-admin-password"`. TOTP enrolment of the `e2e-2fa` user is left to the
  E2E harness (step 14 / WS4).
- Settings seed placeholders (spec §8.4): `tradeName`/`artistName` are localized `{he,en}` objects
  (spec lists them without a shape); zone countries: IL; EUROPE = EU-27 + GB, CH, NO, IS, LI
  (zone **disabled**, routes to quote); NORTH_AMERICA = US, CA; REST_OF_WORLD = `*`. Placeholder
  values not given by the spec: `oversizeFeeIls` 150, `nonConveyableFeeIls` 200, artist delivery
  ₪150, FX 3.7 / 4.0 / 4.7 as of 2026-10-01. Surcharges apply to the three international zones.
