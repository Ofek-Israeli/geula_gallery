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

### M1 steps 7–9 (i18n + RTL shell, message namespaces, auth)

**Spike (c) result: passes.** `next build` with `src/app/[locale]/layout.tsx` as the only root layout
plus `export const dynamic = "force-dynamic"` builds cleanly on Next 16.3.8 (Turbopack). Every
`[locale]` route is `ƒ` (dynamic); only the built-in `/_not-found` is static.

**i18n (`src/i18n/*`, frozen after M1)**
- `routing.ts` builds next-intl routing from `src/lib/locale.ts` (`LOCALE_VALUES`, `Locale`,
  `isLocale`), so `src/server/**` can use locales without importing next-intl (biome forbids it).
  It also exports `dirOf`, `intlLocaleOf` and `TIME_ZONE`.
- `request.ts` resolves the locale as: explicit `locale` → `next/root-params` (`locale()`) →
  next-intl's `requestLocale` (fallback where root params throw: Server Actions, Route Handlers).
  Unknown → `notFound()`. Messages come from `namespaces.ts`; `timeZone` is Asia/Jerusalem.
- `namespaces.ts` statically imports all 40 JSON files (`messages/{he,en}/<ns>.json`) and merges
  them **keyed by file name** (so keys are `common.nav.works`, `admin-shell.login.title`, …). It is
  pure (no next-intl) so `src/server/i18n.ts` (step 11, use-intl/core) can reuse
  `getMessagesFor(locale)`. `NAMESPACE_OWNERS` records the §9.4 owner of each file.
- `app-config.d.ts` augments next-intl's `AppConfig` (typed `Locale` and `Messages`, Hebrew is the
  source of truth). `namespaces.ts` assigns the English object to `const en: Messages`, so **a key
  added to `he` but missing in `en` fails `npm run typecheck`**. Streams add keys to both files.
  `src/server/i18n.ts` (use-intl) may need its own `declare module "use-intl"` augmentation.
- `common` and `emails-core` have real keys; `admin-shell` has the nav/login/2FA/enrol/dashboard
  keys the M1 admin pages use (WS4 owns and extends it); every other namespace is `{}`.
- The root layout renders `<NextIntlClientProvider>` without props, so **all messages are sent to
  the client**. Fine at this size; if bundles grow, pass `messages={pick(...)}` per route group.

**Proxy (`src/proxy.ts`)**
- `^/(he|en)/(admin(?!/login)|print/admin)` without a Better Auth session cookie → 307 to
  `/<l>/admin/login?next=<path>`; everything else → next-intl middleware (`/` → 307 `/he` or `/en`
  by Accept-Language). The cookie is never validated there; a forged cookie reaches the page and
  `requireAdmin` redirects (verified: forged cookie → `/he/admin/login`).
- Matcher `/((?!api|_next|_vercel|.*\\..*).*)`.

**Shell, layouts and 404s**
- `src/app/[locale]/layout.tsx` is the only root layout: `<html lang dir>`, fonts as CSS variables
  (`src/app/fonts.ts`: Frank Ruhl Libre + Assistant, `["hebrew","latin"]`, `display: swap`;
  next/font downloads them at build time, so **`next build` needs network access**), DemoBanner
  when `DEMO_MODE` (bilingual, current locale first, `print:hidden`), `robots: noindex` metadata in
  demo mode, `metadataBase` from `APP_URL`.
- Route-group layouts: `(site)` (skip link, header, footer), `(checkout)` (minimal header/footer,
  noindex), `(print)` (no chrome, noindex), `(print)/print/admin` (`requireAdmin`), `admin`
  (noindex metadata only; **no guard**, login lives below it), `admin/(panel)` (`requireAdmin` +
  nav). `SiteHeader`/`SiteFooter` both carry `CancelPurchaseLink` (also in the minimal checkout
  variants). The footer never shows the ID number; it shows "Merchant country: Israel".
- `(site)/page.tsx` is a placeholder home (M2/WS1 replace it).
- **Next 16.3.8 gotcha — `notFound()` responses are client-rendered.** Any `notFound()` thrown while
  rendering a page returns 404 with an empty `<html id="__next_error__">` shell; the nearest
  `not-found.tsx` is then rendered on the client from the RSC payload. Reproduced in a vanilla
  `create-next-app`-style app with a classic `app/layout.tsx` (dev and prod), so it is framework
  behaviour, not our config. Consequences: (1) we do **not** add a `[...rest]` catch-all — unmatched
  URLs such as `/he/nope/deep` fall through to `global-not-found.tsx`, which is fully
  server-rendered (bilingual, Hebrew first, `lang="he" dir="rtl"`, English section `lang="en"`);
  (2) `[locale]/not-found.tsx` (localized, inside the root layout) is what `notFound()` calls show,
  client-side. E2E 404 assertions must wait for hydration.
- `[locale]/error.tsx` uses the `retry` prop (Next 16.2+; `reset` is the older API).
- Running `next dev` with a custom `NEXT_DIST_DIR` (e.g. `.next-dev`, the worktree `.next-ws<N>`)
  **rewrites `tsconfig.json`** to include `<distDir>/types/**/*.ts`. Revert it (`git checkout
  tsconfig.json`) before committing; never commit those include lines.

**CSS (`src/app/globals.css`, tokens frozen)**
- Tokens are Tailwind `@theme` variables (so `bg-paper`, `text-ink-muted`, `border-line`,
  `bg-reddot`, `text-hold` exist and `--color-*` are on `:root`); every radius is 2 px; fonts map to
  `font-serif` (Frank Ruhl Libre, headings) and `font-sans` (Assistant, body) via `@theme inline`.
- Body 17 px, line height 1.6 (`:lang(he)` 1.7); no italics/small caps in Hebrew; visible
  `:focus-visible` outline; `fade-in` utility is the only motion; reduced motion disables it
  (the `!important`s carry biome-ignore comments). Extra utility `pbe-safe` (safe-area padding).
- Tailwind 4.3.3 already ships the logical utilities (`ms/me/ps/pe`, `inset-s/inset-e`, `mbs/mbe`,
  `pbs/pbe`, `border-s/e`, `rounded-s/e`, `text-start/end`). Physical inline utilities are only
  policed by the step-14 architecture test (`mt-`/`top-`/`bottom-` are block-axis and allowed).

**UI primitives (`src/components/ui/*`, new files allowed after M1, no edits)**
- All §6.3 primitives exist, plus `HoneypotField`. Shared components use `useTranslations`, so they
  work in Server and Client Components. `Field` accepts the control as children or as a render
  function receiving `{ id, required, aria-invalid, aria-describedby }`. `Input` defaults to
  `dir="auto"` and to `ltr` for email/tel/url/number/password. `Price`/`Dimensions` use
  `src/lib/money.ts` / `src/lib/dimensions.ts` (display helpers added now: `formatMoney`,
  `formatCm`, `formatInches` with Unicode eighths, `formatDimensions`); step 12 may extend those
  modules but must keep the signatures. `src/lib/cx.ts` joins class names.
- `Countdown` is display-only; its live region updates once per minute.

**Auth (`src/server/next/{auth,guards,actions,effects}.ts`, `src/server/auth/policy.ts`)**
- `createAuthOptions` gained `rateLimitStorage` and `databaseHooks` parameters. The app passes:
  - `rateLimitStorage` = `security/auth-privacy.ts#authRateLimitStorage`: Better Auth's limiter
    keys (`<ip>|<path>`) are stored in **our** `rate_limits` fixed-window table under
    `auth:<HMAC(key)>`. Deviation: the spec says `storage: 'database'` (Better Auth's own
    `rate_limit` table), but that table stores raw IPs, which violates §7 "IPs are stored only as
    HMAC hashes". Better Auth's `rate_limit` table stays in the schema and is unused by the app.
    These limits are also scaled by `RATE_LIMIT_SCALE` (forced to 1 in production), so E2E
    (scale 100) is not throttled by the 5/15 min rule.
  - `databaseHooks.session.{create,update}.before` = `hashSessionIp`: `session.ip_address` holds the
    IP hash, never the IP.
  - An after-hook (`createAuthMiddleware`) recording failures of `/sign-in/email`,
    `/two-factor/verify-totp` and `/two-factor/verify-backup-code` via
    `security/sign-in-failures.ts`: an `audit_log` row (`auth.sign_in_failed`, actor `anonymous`,
    masked email as `entity_id`, IP hash); when failures in the last 24 h exceed 10, one WARNING
    `AUTH_FAILED_SIGNINS` alert per Asia/Jerusalem day (dedupe key
    `auth-failed-signins:<YYYY-MM-DD>`). Audit errors are logged, never surfaced as 500s.
- `AUTH_RATE_LIMIT_RULES` now also limits `/two-factor/verify-backup-code` (5 per 15 min).
- Better Auth rejects auth POSTs without an `Origin` header (403 `MISSING_OR_NULL_ORIGIN`);
  scripts and tests calling `/api/auth/*` directly must send `Origin: <APP_URL>`.
- `AdminContext` is defined in `src/server/domain/admin.ts` (branded type; domain services import
  the type from there) and re-exported by `guards.ts`. Fields: `userId, email, name, sessionId,
  sessionCreatedAt, twoFactorEnabled, locale, ipHash, actor` (`admin:<userId>`).
- `requireAdmin({ fresh?, allowUnenrolled?, locale? })`: DB-validated session
  (`auth.api.getSession`), else `/<l>/admin/login`; 2FA required and not enrolled →
  `/<l>/admin/enroll-2fa`; `fresh` and older than 30 min → `/<l>/admin/login?reauth=1`. Locale:
  explicit → root param → `he`. The pure decision logic (`checkAdminSession`, `safeAdminNext`,
  `adminLoginPath`) lives in `src/server/auth/policy.ts` and is unit-tested.
- Route handlers: `adminRoute(handler, opts)` (or `requireAdminForRoute(request, opts)`) — Origin
  check for non-GET methods against `APP_URL`'s origin, then the same session checks, answering
  JSON 401/403 instead of redirecting. **The step-14 architecture test must accept `adminRoute(` as
  well as `requireAdmin`**, and must exempt `admin/login/**` (the login and 2FA pages cannot
  require a session; they redirect a signed-in admin to `next` instead).
- `?next=` is accepted only for same-site `/<l>/admin…` or `/<l>/print/admin…` paths (no `//`, no
  backslash, never the login pages); anything else goes to the dashboard.
- Login, 2FA and enrolment run in the browser through `src/lib/auth-client.ts`
  (`getAuthClient()`, created lazily) so the Better Auth limits apply. After success they do a full
  `window.location.assign(next)` so the new cookie is used. Enrolment: password →
  `twoFactor.enable({ password, method: "totp" })` → QR (`qrcode` → data: URL, allowed by
  `img-src data:`), manual key and backup codes → `twoFactor.verifyTotp` → dashboard.
- `admin/(panel)/layout.tsx` + `page.tsx` (dashboard placeholder showing open alert counts) both
  call `requireAdmin`. The mobile bottom tab "עוד" links to `/admin/more`, which WS4 must create.
- Verified by hand against `geula_e2e` with `next start`: logged-out `/he/admin` → 307 login;
  wrong password → inline error; sign-in → dashboard; `/en/admin` LTR; sign-out → login; 6th bad
  sign-in from one IP → 429; 11 failures → one alert; `ADMIN_REQUIRE_2FA=true` + unenrolled user →
  enroll-2fa with no loop (direct `/he/admin` also lands there), enrolment, sign-out, sign-in →
  `/admin/login/2fa`, wrong code → error, TOTP (next 30 s step) → dashboard; `session.ip_address`
  is a 32-hex hash and `rate_limits` keys are `auth:<hash>`. `geula_e2e` was re-seeded afterwards.

**Server Actions (`src/server/next/actions.ts`)**
- `adminAction(schema, handler, { fresh?, name? })` and `publicAction(schema, handler, opts)` return
  `(prev, payload) => Promise<ActionState<T>>` (the `useActionState` shape; call directly as
  `action(null, {...})`). `payload` is `FormData` or a plain object; repeated FormData keys become
  arrays. `locale` must be in every payload (`LOCALE_FIELD`); it is validated separately and zod
  errors use `zod/locales` (`he`/`en`). Handlers return `ServiceResult<T>` (`{ result, effects }`,
  types in `src/server/domain/effects.ts`); throw `ActionFailure(code, details)` for typed
  failures. `unstable_rethrow` keeps `redirect()`/`notFound()` working. Unexpected errors are
  logged (redacted) and returned as `UNEXPECTED`.
- `adminAction` runs `requireAdmin` (with the payload's locale) before parsing.
- `publicAction` order (§5.1): honeypot `company_website` (`SPAM`) → form age (`TOO_FAST`; the page
  renders `<input type="hidden" name={FORM_START_FIELD} value={issueFormStartToken()}>`, a signed
  timestamp, plus `<HoneypotField />`) → IP limits → zod → input-keyed limits (e.g. email) →
  handler → `applyEffects`. Limits are names from `security/limits.ts`; subjects are HMAC-hashed
  into the key.
- `applyEffects` (`next/effects.ts`): `revalidatePath('/', 'layout')` and
  `after(() => processOutbox({ limit: 10 }))`. **Step 11 must replace `loadOutboxProcessor()`**
  (currently returns null) with a dynamic import of `@/server/outbox/process`.

**Security modules (`src/server/security/*`)**
- `crypto.ts` (pure: HKDF sub-keys, HMAC, `safeEqual`, AES-256-GCM `v1.<iv>.<tag>.<ct>` with
  optional AAD), `keys.ts` (extra file: `appKey(purpose)` = HKDF(APP_SECRET, purpose), cached;
  `piiKey()`), `tokens.ts` (`hmacToken` 32 chars, `orderAccessToken(orderId, accessVersion)`,
  expiring `signToken`/`verifySignedToken`, form-start tokens), `ip.ts` (`x-real-ip`, then the
  first `x-forwarded-for`; `hashIp` = HMAC, 32 hex), `redact.ts` (deep key-based redaction,
  `maskEmail`, `maskIdNumber` keeps the last 2, `maskPhone` keeps the last 3), `limits.ts` (§7
  table + `scaledLimit` production guard), `rate-limit.ts` (`rateLimit` atomic upsert,
  `checkLimit(name, subject)`), plus `sign-in-failures.ts` and `auth-privacy.ts`.
- `src/server/log.ts` (redacting JSON logger), `src/server/audit.ts` (`audit(entry, db?)`, redacts
  `before`/`after`; `auditBy(ctx)`), `src/server/alerts/service.ts` (`raiseAlert` idempotent by
  dedupe key, `countOpenAlerts`, `listOpenAlerts`, `acknowledgeAlert`).

**Tests added**: `tests/unit/{security,auth-policy,display-format}.test.ts` (20 tests). Modules that
import `@/server/env` are tested with `vi.mock("@/server/env", …)`.

### M1 steps 10–12 (storage and uploads, outbox/email/cron, contracts, lib, generated types)

**Storage and uploads (step 10, commit 1c9a95d)**
- `StorageAdapter` with the local driver (`.data/uploads/{public,private}`) and a Blob driver; keys
  are `a/b/c.ext` segments (`isSafeKey` rejects traversal, absolute paths, backslashes).
  Signed private URLs use HKDF purpose `file-url`, TTL capped at 10 min.
- `/api/files/public/[...key]` (immutable caching) and `/api/files/private/[...key]` (signed `?t=`
  token or admin session; `private, no-store`, attachment).
- `media/ingest.ts` (sharp): bytes sniffed (JPEG/PNG/WebP only), `limitInputPixels` 100M,
  `.rotate()` first, sRGB with embedded profile, metadata stripped, 2400 px q85 mozjpeg master,
  16 px WebP blur, dominant colour, width/height; `media/og.ts` 1200×630.
- `POST /api/admin/uploads?purpose=artwork|packing|return` via `adminRoute` (session + Origin).
  `artwork` creates the `artwork_images` row → `{ fileKey, imageId }`; `packing`/`return` are
  private-only → `{ fileKey }`.

**Outbox, email, cron (step 11, commit 822558d)**
- Outbox: id-only payload schemas per kind, `enqueue`/`enqueueEmail` (`ON CONFLICT DO NOTHING`),
  `processOutbox` with `FOR UPDATE SKIP LOCKED`, 5-min leases, `min(2^n min, 6 h)` backoff, a
  `reschedule` result that does not count as a failure, DEAD after 8 attempts + CRITICAL alert.
  Every state update is conditional on `(id, RUNNING, attempts)`, so a worker whose lease was
  taken over cannot overwrite a newer claim. The processor uses its own SQL, not `transition()`.
- Handler stubs for all 5 kinds throw `NotImplementedError` (processor treats it as a failure).
- Email: `EmailTemplateId` union and props in `src/emails/types.ts` (UI layer; re-exported by
  `server/email/types.ts`), `Layout` with `lang`/`dir` and the seller/cancellation footer (no ID
  number), stub templates for all 16 ids, react-email `render`, idempotent `sendEmail`, log driver
  (stores html/text), typed Resend stub.
- `GET /api/cron/[job]`: constant-time `Bearer CRON_SECRET`, `cron_runs` rows, 50 s work budget
  inside the 60 s function limit; the `outbox` job is real, the other four are stubs.
  `scripts/cron.ts` is an HTTP client (`--watch` follows `vercel.json`).
- `applyEffects` now dynamically imports the real outbox processor.

**Generated provider types (step 12)**
- `npm run gen:api-types` → `src/server/integrations/generated/*.ts`. Versions used (2026-10-01):
  Cardcom v11 swagger `11.0`; PayPal Orders v2 `2.32`, Payments v2 `2.12`, Webhooks v1 `1.11`
  (`paypal-rest-api-specifications` main); Morning bundle `2.0.0`; **DHL MyDHL `3.3.2`** from
  `developer.dhl.com/sites/default/files/2026-09/dpdhl-express-api-3.3.2.yaml` (the 2.7.2
  fallback was not needed). Each file header records URL, version and sha256.
- **Comments are stripped** by re-printing the output with the TypeScript printer
  (`removeComments`), keeping only our provenance header: 1.4 MB → ~580 KB and no copied
  third-party prose. Types are unchanged.
- **Agents: never print or `Read` whole files under `src/server/integrations/generated/` or
  `openapi/`** (a previous agent was killed by a content filter doing that). Use
  `grep -n '<TypeName>' <file>` with small context.

**`src/lib` (step 12; all implemented and unit-tested except `deadlines.ts` bodies)**
- `money` (BigInt maths for FX and basis points; `fromDecimal` rejects > 2 places, separators,
  exponents), `vat`, `dimensions` (+ orientation, size bucket, volumetric/chargeable weight),
  `format` (Jerusalem formatting, `stripBidi`, DST-safe `addJerusalemDays/Months`), `countries`
  (249 ISO codes, default zones, deny list, `zoneOf(code, settings.zones)`, Intl names; Israel
  first; uninhabited territories hidden), `il-id` (checksum, ID-or-passport parsing, masking),
  `phone` (E.164 without a metadata library: Israeli number plans validated, other countries
  structurally), `script` (spec Latin regex, per-field check), `routes` (locale-less `paths.*` for
  next-intl, `localePath`, `apiPaths.*`, `absoluteUrl`).
- Fixed: `fromJerusalemWallClock` oscillated in the spring-forward gap and returned the instant an
  hour *before* the gap; it now tries the offsets of the day before and after (gap → just after,
  overlap → earlier instant). Tested on 2026-10-25 and 2027-03-26.
- `deadlines.ts`: frozen signatures `cancellationWindow`, `refundDueAt`, `changeOfMindFee` with
  input/output types and the rules in the header; bodies throw (WS6).
- Additions not named in the spec: `src/lib/validation/{identifiers,common,address,messages}.ts`
  (zod primitives; domain checks raise `custom` issues with `params.code`, and
  `next/actions.ts`'s error map resolves them to he/en text via `customIssueMessage`), and
  `src/lib/catalog.ts` (catalog DTOs + `CommerceState` — they live in `src/lib` because
  components may not import `@/server`). `server/domain/ids.ts` re-exports the pure parsers from
  `lib/validation/identifiers`.

**Domain contracts (step 12)**
- `domain/state-machines.ts`: every §3.6 machine as an edge map over the pg enum values. Choices
  where the spec table is implicit:
  - attempt: "any non-final → SUCCEEDED / NEEDS_REFUND / REFUNDED" includes CREATED and EXPIRED
    (EXPIRED is not final: late capture/success); finals are SUCCEEDED, FAILED, CANCELED, REFUNDED;
  - order: no EXPIRED → AWAITING_PAYMENT edge (the table has none). **M2 decides** whether
    "re-reserve an expired hold" on the order page applies only while the order is still
    AWAITING_PAYMENT (current reading) or needs that edge (then add it here);
  - artwork: ON_HOLD ⇄ NOT_FOR_SALE goes through AVAILABLE;
  - refund: REQUESTED → MANUAL_REQUIRED added for offline payments;
  - tax document: ISSUING → NEEDS_MANUAL (modes that cannot issue) and NEEDS_MANUAL → ISSUED
    (admin records a manual document) added;
  - shipment: carrier tracking may skip forward along LABEL_CREATED → … → DELIVERED;
    LABEL_REQUESTED/LABEL_UNKNOWN cannot be cancelled (claim protocol); PICKUP_SCHEDULED →
    LABEL_CREATED when a pickup is cancelled; RECEIVED → CLOSED for cancellations is the duplicate
    path only (service checks `duplicate_of_id`).
- `domain/transition.ts`: refuses edges outside the machine before any SQL, selects the current
  status `FOR UPDATE` (for the audit `before`), runs the conditional UPDATE (+ optional `where`),
  throws `IllegalTransitionError` on 0 rows and audits in the same tx (`skipAudit` for
  high-volume use). Integration-tested.
- `db/tx.ts` (`withTx`, retries 40P01/40001, 3 attempts) was missing and is added.
- Payments: `types.ts` is §4.2 verbatim plus `GatewayDocumentSpec`, factory input types and
  `PROVIDER_DB_VALUE`. `registry.ts` is **implemented**: `checkoutProviders` takes two extra input
  fields, `paypalForIsraeliDestinations` and `liveBlocked` (callers read settings and go-live
  state, which keeps the registry pure); `providerForAttempt` returns
  `ok | offline | not_configured | config_drift` and raises the CRITICAL `CONFIG_DRIFT` alert.
  Cardcom/PayPal stubs expose real identity and capabilities from env (`CARDCOM_WALLETS` values
  `applepay`/`googlepay` map to `apple_pay`/`google_pay`); every network method throws
  `ProviderNotConfiguredError`. The mock provider is a stub for M2. `finalize/apply/refunds/
  offline.ts` hold the frozen signatures.
- Tax documents: contract, registry by `TAX_DOCUMENTS_MODE`, extra `none.ts` (complete) and
  `TaxDocumentNeedsManualError`; gateway mode throws it for standalone receipts and credit notes;
  Morning/gateway builders are WS5 stubs; mock is an M2 stub; `issue.ts` entry points.
- Shipping: engine types (`ShippingQuoteResult` carries `insured` and `insuredValueMinor`),
  `CarrierAdapter`, frozen `rates.ts`/`rules.ts` signatures (M2 then WS3), customs constants,
  carriers manual (complete) / mock / dhl (bases and tracking URL; DHL host
  `express.api.dhl.com` to be confirmed by WS3) and `carrierFor(country)`.
- Checkout: shared types, `lockArtworks` and the §3.5 `isReservable`/`isSellable` predicates
  (implemented and tested; the SQL forms are M2's), plus signatures for the rest of §9.3.
- **Settings change:** shipping surcharges now use the spec's wording — `kind: 'PCT' | 'FIXED'`,
  `zones: 'ALL' | ZoneId[]`, `startsOn`/`endsOn` inclusive. The seed is insert-only (it never
  overwrites painter edits), so the existing `shipping` rows in `geula_dev` and `geula_e2e` were
  converted with a one-off JSONB `UPDATE`. A fresh `db:reset` needs nothing.

**Gotchas found in this step**
- **File-sync duplicates.** Something syncing this folder (it lives under `~/Desktop`) creates
  `"<name> 2"` copies: empty `node_modules/@types/{cors 2,ws 2}` dirs (break `tsc` with TS2688),
  `.next/types/* 2.ts` (duplicate-identifier errors), ~80 files in `node_modules`, and
  **`.git/index 2` — at one point `.git/index` itself was replaced by a stale copy**, so commit
  `6125064` recorded the deletion of 259 files. `5bac41f` re-adds them unchanged (the working
  tree matched `06b6383` byte for byte). **Squash `5bac41f` into `6125064` before pushing.**
  After every commit, sanity-check `git ls-tree -r HEAD --name-only | wc -l` and
  `git diff --cached --name-status` for unexpected `D` lines. Consider moving the repo out of a
  synced folder.
- zsh: `while read … path` overwrites `$PATH` (zsh ties `path` to `PATH`); use another name.

### M1 steps 13–15 (spikes, test harness, M1 acceptance)

**Spike results (step 13, 2026-10-01)**
- **(a) react-pdf Hebrew + English: GO for the Tier B disclosure PDF.** A bilingual disclosure
  sample (`@react-pdf/renderer` 4.9.0, static Assistant/Frank Ruhl Libre TTFs) was rendered to a
  PDF, rasterised with ImageMagick/Ghostscript and inspected, and the glyph order was checked
  with Ghostscript `txtwrite` (visual order per line). Correct: Hebrew shaping and order,
  mirrored parentheses, `₪1,500` / `US$ 45.00` / `03-000-0000` / dates / `GG-…` / e-mail runs
  inside Hebrew lines, Hebrew inside English lines, and the line order of a wrapped multi-line
  Hebrew paragraph. Rules for WS6 (encoded in `src/server/documents/pdf/fonts.ts`):
  - every Hebrew paragraph needs `direction: 'rtl'` (helper `rtlText(true)`); without it a
    line that starts with a Latin token is laid out LTR. `direction` works but is missing from
    react-pdf's `Style` type, hence the cast in the helper;
  - for label/value rows use `flexDirection: 'row-reverse'` in Hebrew;
  - hyphenation is disabled (`registerHyphenationCallback`), otherwise Hebrew words get split;
  - react-pdf cannot use variable fonts: `assets/fonts/*.ttf` are static wght 400/700 instances
    of the Google Fonts variable TTFs made with `fontTools.varLib.instancer --static
    --update-name-table` (licence texts in `assets/fonts/OFL.txt`). The fallback (separate
    `<Text>` runs or HTML only) was not needed.
- **(b) react-email in a Route Handler and inside `after()` from a Server Action: works** with
  the default `serverExternalPackages`; no config change needed. Verified on `next start`
  through the project's own `renderEmail()` (subject, html with `dir`, plain text), and with a
  form-bound Server Action whose `after()` callback rendered the template after the response
  (driven by Playwright; POST 200, no page errors).
- **(c) `next build` with `[locale]/layout.tsx` as the only root layout + `force-dynamic`:
  passes** (Turbopack, ~8 s); every route is `ƒ` except the global not-found.
- **(d) Fonts from the traced output: works.** `outputFileTracingIncludes: { '/*':
  ['./assets/fonts/**/*'] }` puts the four TTFs into every route's `.nft.json` (checked for a
  route handler, a page and `/api/cron/[job]`). A temporary `output: 'standalone'` build was
  copied to the scratchpad (outside the repo) and its `server.js` rendered a PDF with the
  Assistant font embedded, resolving `process.cwd()/assets/fonts`. `next start` from the repo
  also renders it. Standalone output is **not** enabled in the committed config.
- Spike code (temporary routes, a page and an action) was deleted after the run; only
  `assets/fonts/**` and `src/server/documents/pdf/fonts.ts` (`registerPdfFonts`, `rtlText`) are
  kept for WS6.
- **Gotcha:** `next build` with `NEXT_DIST_DIR=<dir>` appends `<dir>/types/**/*.ts` and
  `<dir>/dev/types/**/*.ts` to `tsconfig.json` `include` (exact-string check) and reformats the
  file. `.next-e2e` entries are pre-added so `test:e2e` leaves the tree clean (the `.next-*`
  exclude keeps them out of `tsc`). Worktrees using `.next-ws<N>` will see the same edit:
  revert it (`git checkout tsconfig.json`) rather than committing it.

**Test harness (step 14)**
- `vitest.config.ts`: projects `unit`, `contract`, `integration`. Integration: `globalSetup`
  (`tests/integration/global-setup.ts`) **drops and re-migrates** the local TEST_DATABASE_URL
  database once per run (refuses non-localhost; tells you to run `db:setup` if it is missing);
  `setupFiles` (`tests/integration/setup.ts`) replaces the app env keys with `testEnv()` from
  `tests/helpers/db.ts` (fixed `test-` secrets, mocks, log email, `.data/test-uploads`,
  provider credentials scrubbed) before any app module loads, and ends the app pool after each
  file; `fileParallelism: false`.
- Frozen helpers (§9.3):
  - `db.ts`: `testDatabaseUrl()`, `testEnv()`/`applyTestEnv()`, `newClient()`, `truncateAll()`
    (every `public` table, `RESTART IDENTITY CASCADE`), `seedBaseline()` (the `settings` seed
    module), `resetDatabase()`, **`cleanDatabaseBeforeEach({ seed? })`** (named without `use…`
    because biome treats `use*` calls as React hooks), `pgErrorCode()`/`pgConstraint()` (read
    through Drizzle's `DrizzleQueryError.cause`) and `expectPgError(promise, code, constraint?)`;
  - `race.ts`: `race(n, fn)` (dedicated `pg.Client`s released by a barrier, each with its own
    Drizzle instance typed as the app `Db`), `createBarrier`, `partition`, `deadlockCount()`
    (flushes pg stats first), `watchLockWaits()` (samples `pg_stat_activity` lock waits);
  - `mailbox.ts`: `createMailbox(url)` reads `email_messages` (`list`/`latest`/`waitFor`), for
    the integration and the E2E database;
  - `mock-webhook.ts`: body, `x-mock-signature` signing, forged/unsigned variants, `fetch` POST;
  - `totp.ts`: RFC 6238 (checked against the RFC vectors), base32, `secretFromTotpUri`;
  - `factories/core.ts`: `uniqueSuffix`, `uniqueBuyer` (`@example.test`, `+972-3-000-0000`),
    `testOrderNumber`, and schema-level row builders `insertArtwork`, `insertOrder` (+ items),
    `insertPaymentAttempt`, `insertSale`. Schema modules are imported lazily, so Playwright specs
    can import `uniqueBuyer()` without loading `server-only` code.
- `schema-constraints`: second active sale (per artwork and per order item) and second winning
  attempt (insert and update) → 23505; reservation pair / AVAILABLE-only / sold_at CHECKs;
  IL ⇒ ILS; demo ⇒ not LIVE; mock ⇒ MOCK mode; total sum; PAID needs an attempt; amount > 0;
  deleting an order that holds a reservation → **23001** (`ON DELETE RESTRICT` raises
  `restrict_violation`, not 23503). `harness.test.ts` checks the helpers themselves.
- `architecture.test.ts` parses sources with the TypeScript compiler API (imports, dynamic
  imports, `import()` types, `process.env` reads, call names, string literals), so comments that
  mention a rule do not trip it. Interpretations: UI components may use `next/link`,
  `next/navigation` hooks etc.; only `next/headers`, `next/cache`, `next/server`,
  `next/root-params` and `better-auth/next-js` are Next-layer-only (`src/app`, `src/server/next`,
  `src/i18n`, `proxy.ts`, `instrumentation.ts`); services/lib/emails/content import no `next*`
  at all. `admin/login/**` pages are exempt from the `requireAdmin` rule (no session yet), and
  `adminRoute(...)` / `requireAdminForRoute(...)` count as calling `requireAdmin`. The
  Tailwind rule scans string literals of `.tsx` files and `src/components/**`. Each rule was
  mutation-checked with a deliberately bad file.
- `check:secrets` (`scripts/check-secrets.ts`): working tree (`git ls-files -co
  --exclude-standard`, so ignored `.env.local` is not read) or `--stdin` history patches (added
  lines only). Values are masked in output. The Cardcom test ApiName is matched by SHA-256 of
  each lower-cased alphanumeric token (only the hash is stored). PII rules apply to
  `tests/fixtures/**`, `scripts/seed/**`, `data/**` and any `fixtures/` folder. Deviation:
  values containing `unused` are allowed in addition to the spec's exceptions, because an M1
  unit test committed `e2eAdminPassword: "unused-password"` (now `test-unused-password`) and
  the history scan must be clean. Bare `NAME=value` assignments are checked only in `.env*`,
  YAML and shell files; in code only quoted literals count; values that look like env-var names
  (`BLOB_READ_WRITE_TOKEN` in an error message) are ignored. History scan
  (`git log -p --format= | npm run check:secrets -- --stdin`): clean.
- Playwright (`playwright.config.ts`): webServer exactly as §10.4 with `/api/health` (new;
  `SELECT 1`, `{ ok }` only) as the readiness URL; the server env is pinned and every
  `CARDCOM_/PAYPAL_/MORNING_/DHL_/RESEND_/BLOB_` key inherited from the shell or `.env.local` is
  blanked. E2E users come from `SEED_E2E_USERS=true` (`e2e-admin@example.test`,
  `e2e-2fa@example.test`, password `e2e-admin-password`); constants in `tests/e2e/e2e-env.ts`.
  `globalSetup` signs in through `/api/auth/sign-in/email` (with an `Origin` header) and saves
  `tests/e2e/.auth/admin.json`; Playwright starts the web server before global setup.
  `E2E_REUSE_SERVER=1` reuses a running server. The smoke spec lists the pages later milestones
  add (works, artwork, about, legal, checkout, order) as `test.fixme` with their owner.
- `.github/dependabot.yml` (weekly npm, grouped; monthly actions) and the AGENTS.md project
  rules (§9.6) are added.

**M1 acceptance (step 15, 2026-10-01)**
- `npm run env:init` (kept the existing `.env.local`) → `npm ci` (clean reinstall; removed ~1,300
  sync-created duplicates in `node_modules`) → `npm run db:setup` → `npm run db:reset -- --seed
  none --yes`: ok.
- `npm run lint`, `npm run typecheck`, `npm run check:secrets` (working tree and history): pass.
- `npm run build`: pass. `npm test`: 25 files / 196 tests. `npm run test:integration`: 4 files /
  39 tests (including `schema-constraints`; `architecture` is in `npm test`).
- `curl -sI localhost:3000/` → 307 `location: /he` (`Accept-Language: en-US` → `/en`); `/he` has
  `<html lang="he" dir="rtl">`, `/en` `lang="en" dir="ltr"`; logged out `/he/admin` → 307 to
  `/he/admin/login?next=%2Fhe%2Fadmin`; after `npm run admin:create`, sign-in → 200 and
  `/he/admin` → 200, a wrong password → 401; with `ADMIN_REQUIRE_2FA=true` a fresh user signing in
  through the login form lands on `/he/admin/enroll-2fa` and stays there (no loop).
- `npm run test:e2e` (smoke): 23 passed, 12 `fixme` (pages from later milestones), desktop and
  mobile projects.
- npm 11 gates install scripts: `npm install-scripts ls` lists esbuild, @swc/core and
  @parcel/watcher as not approved. Nothing in build or tests needs them (platform binaries come
  from optional dependencies); approve them only if a tool fails.

**Independent M1 acceptance review (2026-10-01)**
- Re-ran from a clean state: `npm ci`, `db:setup`, `db:reset -- --seed none --yes`, lint,
  typecheck, `check:secrets` (tree and `git log -p --all` history), build, `npm test`,
  `test:integration`, smoke E2E. All pass. `npm run db:generate` reports no schema drift.
- Built server on a spare port (`APP_URL` set to that port so Better Auth's origin check
  passes): `/` → 307 `/he` (`/en` for English), `dir` rtl/ltr, logged-out `/he/admin` → login,
  sign-in 200 / dashboard 200 / wrong password 401, `ADMIN_REQUIRE_2FA=true` → enroll-2fa with no
  loop. `/api/admin/uploads`: `packing` and `return` → 201 `{ fileKey }`, `artwork` with a real
  artwork → 201 `{ fileKey, imageId }`, missing/unknown artwork → 400/404, bad purpose → 400,
  foreign Origin → 403, anonymous → 403; anonymous private file → 401; anonymous cron → 401.
- Added `tests/unit/csp.test.ts` (§10.1 `csp`) and `tests/unit/env.test.ts` (step 5 derivations
  and §4.8 cross-field rules); neither had coverage.
- Open before push: commit `6125064` records 259 deletions that `5bac41f` restores (sync-corrupted
  index). Squash `5bac41f` into `6125064` (needs a history rewrite, so it is the integrator's call)
  and move the repo out of the synced Desktop folder. `.git/index 2` is a harmless stray.

### M2 part 1 (demo catalog, minimal storefront, shipping engine basics)

**Demo images (`npm run demo:fetch-images`, run 2026-10-01)**
- `scripts/fetch-demo-images.ts` + `scripts/lib/{demo-curation,demo-manifest,parse-aic-dimensions,
  procedural-painting}.ts`. The curated §8.3 table (bilingual titles, artists, dates, medium and
  surface, mm dimensions, series, statuses, prices, flags, **alt texts written from the images**)
  lives in `demo-curation.ts`; the script merges it with the AIC metadata (one request; refuses a
  work that is not public domain, whose `image_id` differs or whose first `dimensions` segment
  disagrees with the curated mm by > 1 mm) and the processed images into
  `data/demo-manifest.json` (zod schema in `demo-manifest.ts`). The seed reads only the manifest.
- All 16 downloads succeeded (0 fallback images); ~5.1 MB of JPEGs (≤ 2000 px, q80 mozjpeg).
  `--offline` renders deterministic procedural paintings instead; `--reuse` keeps the processed
  images and rebuilds the manifest (use it after editing curation data); `--only <ids>`.
- Choice: "ILS only" (212300) is read as a **domestic-only listing** (`shipsInternationally:
  false`, no USD price). That is what makes §8.3's list of internationally purchasable works come
  out exactly (otherwise its ₪8,900 is under the USD 2,500 cap). Featured works: 256797 (home hero)
  and 100476. Demo works have `signed: false` (no claim we cannot verify), `coaIncluded: true`,
  `readyToHang` for unrolled canvases.
- `check:secrets`: the nine-digit ID rule now ignores digit runs inside longer alphanumeric
  tokens (sha256 hex and base64 in the manifest tripped it).

**Shipping engine (`shipping/rates.ts`, `rules.ts`; unit tests `shipping-rates`, `shipping-rules`)**
- Implemented per §4.4 with these readings where the spec is open:
  - `quote_only` and actual > 70 kg beat a size-class override; any other QUOTE reason (crate,
    glazing, ≥ 25 kg, > 45 kg chargeable) can be overridden by the painter. `oversizePiece` =
    does not fit M; the oversize fee is charged only for an oversize piece overridden to S/M; the
    non-conveyable fee for 25–70 kg actual when overridden out of QUOTE.
  - A ROLLED_TUBE work is measured as the tube (`rolledTubeBox`, from the artwork dimensions);
    a tube for a work with `can_be_rolled = false` → QUOTE (`NOT_ROLLABLE`). The stored packed
    weight is used.
  - PCT surcharges are a percentage of the base class rate; FIXED is ILS per piece; windows are
    inclusive Jerusalem calendar days (`jerusalemDateKey`).
  - Insurance only abroad with CARRIER_TABLE, when `insurance.enabled` and provider ≠ NONE, and
    either provider THIRD_PARTY or provider DHL with carrier DHL/MOCK. The IL domestic courier,
    pickup and artist delivery are never insured (no setting exists for "unless the painter sets
    otherwise"; add one in WS3 if needed). `insuredValueMinor` is 0 when not insured. Several
    works: the artwork cap is Σ caps only when every work has one.
  - USD: shipping and insurance are each converted with `ilsToUsdCeilWhole`; `breakdown` stays in
    ILS minor units. `quoteShipping` throws for IL + USD.
  - Methods: LOCAL_PICKUP / ARTIST_DELIVERY are Israel-only flat fees; outside Israel or disabled →
    `blocked` with `ZONE_DISABLED` (no better frozen code). QUOTED → `quote_only` QUOTE_ONLY.
    CARRIER_TABLE in IL uses carrier MANUAL; abroad the `carrier` input.
  - Precedence: destination `blocked` → NOT_INTERNATIONAL (also used for a `local_pickup_only`
    work by carrier anywhere) → destination `quote_only` → per-work QUOTE_ONLY → SIZE_QUOTE.
  - `evaluateDestination`: deny list → IL ok → GB ≤ GBP 135 blocked (checked before the disabled
    EUROPE zone) → quote-only countries → disabled zone (`quote_only` ZONE_DISABLED) → carrier
    value cap (`quote_only` VALUE_CAP). Notices for every international destination; the EU EUR 3
    window cannot be checked (the frozen signature has no date). Thresholds are converted to ILS
    minor with the dated FX (exact BigInt maths), never the value to a float.
  - `zoneEstimates`: carrier-table price on the date + the **minimum** premium when insured
    (international zones assume DHL); value caps are not applied there.
  - `TRANSIT_ESTIMATE` is added to every international `ok` quote.
- Extra exports: `rolledTubeBox`, `packedBox`, `activeSurcharges`, `insuranceSupported`,
  `insuredValueMinor`, `insurancePremiumMinor` (rates); `nonLatinAddressFields` (rules).
- `scripts/seed/packaging.ts#demoPackaging` implements the §8.3 packaging defaults; the expected
  class table is asserted through it (packed mm, grams, volumetric kg to 2 decimals, class).

**Seeds**
- `catalog.ts`: 5 series + 16 works from the manifest, `ON CONFLICT (slug) DO NOTHING` (painter
  edits survive a re-seed). Images go through `media/ingest.ts` and a **seed-side
  `StorageAdapter`** (`scripts/seed/storage.ts`, local layout only), because `@/server/storage`
  imports key signing → `security/keys.ts` → `env.ts`, which seeds must not load. Keys are
  content-derived (`artworks/demo/<aicId>-<hash12>.jpg`, `originals/demo/…`, `og/demo/…`), so
  re-runs overwrite instead of piling up. `STORAGE_DRIVER=blob` makes the demo seed throw.
  `SeedEnv` gained optional `storageDriver`/`storageDir` (`LOCAL_STORAGE_DIR`).
- `orders.ts` (M2 stub; WS6 replaces it): locks each sold work, inserts an OFFLINE `is_mock`
  sale at the list price and sets SOLD with a conditional UPDATE (sold 30/10/3 days ago).
- `db:reset` (demo) takes ~4 s.

**Catalog and storefront (minimal; WS1 owns and polishes)**
- `server/catalog/commerce-state.ts`: `commerceStateOf(row, now)` + `commerceColumns`
  (includes the in-flight-hold `EXISTS` subquery). An expired hold whose order has a
  CAPTURING/PAYMENT_REVIEW attempt shows as `reserved` (until = now). `buyable` = published,
  priced, not quote-only, not price-on-request (demo/live provider checks are checkout's).
- `server/catalog/queries.ts`: `listArtworks` (current = AVAILABLE, ON_HOLD, NOT_FOR_SALE ordered
  by status then featured then sort order; `sold` archive by `sold_at desc`), `listRecentlySold`,
  `getFeaturedArtwork`, `getArtworkPage` (DTO + `ArtworkShipSpec`), `getDeliveryEstimates`
  (`{ zones, pickupFree }`), `listCredits`.
- `src/lib/catalog.ts` gained `ZoneEstimateDTO` and `CreditDTO` (additive, before contracts-v1).
- Pages: home (featured work as LCP with `loading="eager"` + `fetchPriority="high"`; Next 16
  deprecates `priority`), `/works` (+ `?availability=sold`, `?page`), `/works/[slug]`, `/credits`.
  Components in `src/components/artwork/` (`ArtworkCard`, `WorksGrid`, `ArtworkStatus`,
  `LiveBuyBox`, `ArtworkFacts`). Buy now links to `/checkout/<slug>` (the route lands in M2
  part 2; today it 404s). Not done (WS1): filters/sorts, lightbox and thumbnails, JSON-LD,
  sticky mobile buy bar, sitemap, full metadata, about/contact pages (links 404 for now).
- Messages: real keys in `catalog` and `artwork` (WS1-owned files; WS1 extends them).
- E2E: `tests/e2e/storefront-minimal.spec.ts` (@smoke) and the works/artwork cancel-link
  smoke tests (their `fixme`s removed). Integration: `catalog-seed.test.ts`.
- **Gotcha:** with the new pages, `next start` logs `⨯ Error: The destination stream closed
  early.` a few times during E2E. It appears when Playwright navigates away while a response or
  `<Link>` prefetch is still streaming; every test passes and no page errors are reported. Not
  investigated further.

### M2 part 2 (checkout, reservations, mock provider, finalization, refunds, order page)

**What exists**
- `server/checkout/`: `quote.ts` (`getCheckoutQuote`), `pricing.ts` (ship spec, item price per
  currency, shipping options, order amounts + VAT), `reservations.ts` (lock helpers, SQL forms of the
  predicates, advisory locks, caps, reserve, takeover expiry, release), `start.ts` (`startCheckout`,
  `startPaymentForOrder`, `launchAttempt`, `orderUrlFor`), `release.ts` (`releaseReservation`,
  `expireStaleOrders`), `requote.ts` (`requoteOrder`, `shippingQuoteForOrder`), `conversation.ts`,
  `order-view.ts` (buyer order page data, token-checked).
- `server/payments/`: `finalize.ts`, `capture.ts`, `apply.ts` (`applySuccessfulPayment`,
  `markNeedsRefund`, `lockPaymentContext`), `refunds.ts` (request / execute / reconcile / lease expiry /
  manual done / confirm failure / retry / settle), `post-success.ts` (refund, reversal and dispute
  sync with matching), `webhook.ts` (`handlePaymentWebhook`, `processPaymentEvent`,
  `unprocessedEventIds`, `handlePaymentReturn`), `providers/mock.ts` (full mock).
- Routes: `POST /api/payments/[provider]/webhook`, `GET /api/payments/[provider]/return`,
  `POST /api/mock-pay`; pages `(checkout)/checkout/[slug]`, `(checkout)/checkout/returned`,
  `(checkout)/mock-pay/[ref]`, `(site)/orders/[number]`.
- Outbox handlers `REFUND_PAYMENT` (→ `executeRefund`) and `REFUND_SETTLED` (→ `settleRefund`).
  `SEND_EMAIL` and `ISSUE_TAX_DOCUMENT` / `ISSUE_CREDIT_NOTE` are **still stubs** (M2 part 3 / WS6 /
  WS2): jobs are enqueued correctly and back off until their handlers land.
- Tests: integration `reserve-race`, `finalize`, `capture-race`, `refunds` (49 tests); unit
  `mock-signature`; e2e `checkout-minimal` (desktop only, it buys `icebound`). Factories in
  `tests/helpers/factories/commerce.ts` drive the real services (`heldOrder`, `clickMockPay`,
  `patchSetting`, `execSql`).

**Decisions and deviations**
- Contract changes before `contracts-v1` (additive or renamed):
  - `FinalizeOutcome` now follows spec §5.2 (`paid` instead of `applied`, plus `refunded`,
    `lost_before_capture`, `unknown`, `capturing`); `FinalizeResult` has `orderId`;
    `FinalizeOptions.db` is a `Db` (not a tx) and takes `env`.
  - `ApplyOutcome` gained `deferred` and `late`.
  - `CheckoutQuote.ok.providers[]` carries `wallets` and `installments`; `label` is just the id (the
    UI translates `checkout.provider.<id>`).
  - Services take an optional `deps` (`{ db, env }`) so race tests run each contender on its own
    connection. `requestRefund(input, db)` joins the caller's transaction when `db` is a tx.
- State machines: order `EXPIRED → AWAITING_PAYMENT` (only the capture claim / a late review re-opens
  an expired order); attempt `PENDING/AWAITING_CAPTURE/EXPIRED → PAYMENT_REVIEW` (a provider that
  reports review without a capture: the mock's "Mark under review") and `EXPIRED → CANCELED` (late
  capture claim on a lost work).
- The order page "Pay" never re-opens an EXPIRED order (the M1 open question): only
  AWAITING_PAYMENT orders get a new attempt; an expired *hold* on an AWAITING_PAYMENT order is
  re-reserved within the budget (hold_count ≤ 3, WEB span ≤ 2 h, caps).
- Anti-hoarding: only WEB orders count; the cooldown counts orders of the same buyer (email or IP
  hash) whose `expires_at` lapsed within `holdCooldownMinutes` with reason null / HOLD_EXPIRED /
  HOLD_TAKEN_OVER (an explicit "release" is not a lapse). The 24 h per-artwork budget counts orders
  by `first_held_at`.
- A concurrent double submit with the same `client_request_id`: the loser re-checks for the twin
  after locking the artwork and resumes it (otherwise it would see `just_reserved`).
- Go-live blockers (`golive.ts`, WS6) are approximated by `!business_profile.completed` for
  `liveBlocked` (only affects LIVE providers).
- `requoteOrder` refuses a currency change (items are immutable and priced in the order currency).
- Review: a direct-flow "review" moves attempt and order to PAYMENT_REVIEW only when the order is
  open, bound, sellable and has no other in-flight attempt; otherwise the attempt just keeps being
  polled (a success later goes through `applySuccessfulPayment`, i.e. NEEDS_REFUND when lost).
- Capture watch release: the hold is shortened to `now()` (and the order's `expires_at`), the expiry
  sweep then releases it.
- A verification mismatch on a `requires_capture` approval → FAILED + CRITICAL alert (no money).
  With money taken → NEEDS_REFUND AMOUNT_MISMATCH with a MANUAL_REQUIRED refund for the *received*
  amount, no job, no receipt.
- Refund outcomes: `ProviderRejectedError` → FAILED; timeouts, invalid responses and
  `ProviderUnavailableError` → UNKNOWN (reconcile asks `getRefund`; `not_found` → FAILED, still
  counted until an admin confirms); no `getRefund` → MANUAL_REQUIRED. `retryRefund(id, actor)` is an
  extra function (FAILED + confirmed → REQUESTED with a new `idem_key` and job dedupe key
  `refund:<id>:<idemKey>`).
- The mock hosted page buttons are a plain `POST /api/mock-pay` answered with 303, not Server
  Actions: a Server Action `redirect()` to a same-origin `/api/...` URL is soft-navigated by the
  App Router and never reaches the return route. Real providers are other origins, unaffected.
- The return route reports an `already_final` attempt by its final state (`payment=paid`, …).
- `buildPreContract` got a minimal bilingual body (seller incl. ID number and "Merchant country:
  Israel", work, price with VAT wording, delivery, payment, cancellation, DAP, s.11, links). WS6 owns
  the final text and `buildDisclosure` (still throws). `src/content/legal/versions.ts` holds draft
  versions stored on orders.
- Mock provider hooks (`mockProviderHooks`, test only, ignored in production) inject capture/refund
  timeouts (before or after applying), review-on-capture, rejected/pending refunds and fetch timeouts;
  `resolveMockReview(ref, "PAID" | "DECLINED")` resolves a review.

**Gotchas**
- `providers/mock.ts` loads the DB client lazily (`appDb()`): unit tests import its constants
  without an environment.
- Pass a dedicated-connection `db` through every service call in race tests; quote/start read
  settings sequentially because one `pg.Client` cannot run parallel queries (pg 8 warns).
- In dev, Playwright screenshots taken before hydration inject `caret-color` styles and cause a
  harmless hydration warning.
- `checkout/returned` is a static segment next to `checkout/[slug]`: an artwork slug `returned` would
  be shadowed.
- Running `next dev` with `NEXT_DIST_DIR` rewrites `tsconfig.json`; revert it before committing.

**Not done here (M2 part 3 / streams)**: the `reconcile` cron job body (all building blocks exist:
`unprocessedEventIds` + `processPaymentEvent`, attempts by `next_check_at` + `finalizeAttempt(…,
"reconcile")`, `refundsToReconcile` + `reconcileRefund`, `expireRefundLeases`, `expireStaleOrders`),
the SEND_EMAIL handler with `order-confirmation` / `painter-new-order` / `purchase-not-completed` /
`payment-review` / `refund-issued` props, mock tax documents, the admin order list/detail with
Recheck, the PayPal refund-webhook routing into `syncPostSuccessEvent` (WS5), link orders
(`createLinkOrder`), offline payments, and the e2e specs `purchase-il`, `webhook`, `order-retry`,
`race`.

### M2 part 3 (outbox handlers, mock tax documents, admin orders, reconcile, M2 E2E, `contracts-v1`)

**What exists**
- Tax documents (`taxdocs/mock.ts`, `taxdocs/issue.ts`, handlers `ISSUE_TAX_DOCUMENT` /
  `ISSUE_CREDIT_NOTE`): the full §4.3 exactly-once protocol, provider-agnostic, so Morning/gateway
  (WS5) plug into the same runner. `IssueOutcome` gained `failed`.
- Emails: real templates for `order-confirmation` (first version; WS6 finalizes),
  `painter-new-order`, `payment-review`, `purchase-not-completed`, `refund-issued`, `receipt`
  (shared bits in `src/emails/parts.tsx`). `server/email/props.ts` builds every template's props
  from fresh data (refId table in its header); `SEND_EMAIL` sends once per dedupe key and stamps
  `disclosure_sent_at` / `disclosure_version` on the first order-confirmation.
- Documents: `server/documents/data.ts` (order snapshots → `DisclosureInput`, buyer URLs),
  `server/documents/buyer.ts` (token-checked reads), pages `/[locale]/print/disclosure/[number]`
  and `/[locale]/print/receipt/[docNumber]` (DEMO stamp in both languages),
  `components/docs/DocumentSections.tsx`. `buildDisclosure` has a minimal bilingual body
  (pre-contract sections + order rows + copyright + email summary); WS6 owns the final text.
- Admin: `/admin/orders` (status filter, search), `/admin/orders/[id]` (summary, buyer, attempts
  with **Recheck payment**, refunds, tax documents, shipment, emails, alerts, audit timeline),
  services in `server/orders/admin.ts`, actions in `orders/[id]/actions.ts`, client forms
  `components/admin/{RecheckButton,ManualTrackingForm}.tsx`. Minimal manual tracking:
  `shipping/shipments.ts#recordManualTracking`.
- Cron: `jobs/reconcile.ts` (events → due attempts → refund leases + UNKNOWN/PROVIDER_PENDING
  refunds → lapsed holds), per-step counters in `cron_runs.stats`.
- Tests: integration `taxdocs`, `outbox-emails`, `reconcile-job`, `admin-orders`; E2E
  `purchase-il`, `webhook`, `order-retry`, `race` + `tests/e2e/support/commerce.ts`.

**Decisions and deviations**
- Mock document numbers are `DEMO-<order suffix>-R<n>` / `-C<n>` (derived from the marker, unique
  and stable across retries) instead of the spec's `DEMO-000123` example; no counter table needed.
  The mock's `findByMarker` answers from process memory (a restart = "confirmed absent" →
  re-issue, harmless because issuing is idempotent per marker).
- Markers: receipt `<order>/<RECEIPT|INVOICE_RECEIPT>/<attempt seq>`; credit note
  `<order>/CREDIT_NOTE/<n>` with n = position of the refund among the order's refunds. Kind
  RECEIPT for patur, INVOICE_RECEIPT for murshe (type codes 400/320/330 like Morning).
- `tax_documents.attempts` = provider calls while ISSUING, inconclusive searches while UNKNOWN
  (reset to 0 on entering UNKNOWN). An ISSUING row whose call is > 2 min old is treated as an
  abandoned call → UNKNOWN. `ProviderNotConfiguredError` → FAILED (+ alert), like a 4xx. A
  provider without `findByMarker` → NEEDS_MANUAL straight from UNKNOWN.
- Credit note without a receipt row: reschedule while the receipt job is PENDING/RUNNING, skip
  when it finished without a document (not eligible), NEEDS_MANUAL when it is DEAD or the receipt
  ended FAILED/NEEDS_MANUAL.
- Receipt lines are itemized (works + shipping + insurance) only when the attempt amount equals
  the order total; otherwise one "payment for order …" line (stale-quote/duplicate payments).
- Email templates owned by later streams (requests, cancellations, checkout-link, pickup,
  admin-alert) have **no props builder yet**: their jobs fail loudly (`NotImplementedError`) rather
  than sending a stub. Each owner adds its builder in `email/props.ts`.
- `shipment-update` emails use refId `<shipmentId>:<status>` (dedupe
  `email:shipment-update:<id>:<status>:<to>`); the template itself is still the M1 stub (WS3).
- Manual tracking (minimal, until WS3's fulfillment screen): PAID + unblocked carrier orders only;
  AWAITING_FULFILLMENT → PACKED → LABEL_CREATED (→ IN_TRANSIT when "handed over"), no packing
  checklist or disclosure-printed guard yet; no buyer email for PACKED; a later entry only corrects
  the tracking details. Duplicate tracking number → `TRACKING_NUMBER_IN_USE`.
- Admin order services live in `server/orders/admin.ts` (the spec tree names no module for them).
- Reconcile step 4 does not expire link-order requests yet (no link orders exist; WS2).
- E2E specs send their own `x-real-ip` (`buyerIp(n)`): the per-IP live-hold cap (3) is a setting,
  not scaled by `RATE_LIMIT_SCALE`, and parallel specs share localhost. Each spec buys its own demo
  work (allocation: checkout-minimal `icebound`; purchase-il `movement-no-10`; webhook
  `still-life-green-flower-vase` + `a-holiday` (released); order-retry `still-life-no-15` +
  `beach-les-grands-sables` (released); race `at-the-rivers-bend`). Free for later specs:
  `beach-at-cabasson`, `banks-of-the-durance` (quote only), and `landscape-no-26` / `antibes`
  (used read-only — do not buy them).
- `storefront-minimal` no longer expects "Moonrise" in the 4-item recently-sold strip (parallel
  purchases push it out); it checks the strip size and the sold archive instead.

**Gotchas**
- A job enqueued by a handler (e.g. the receipt email enqueued when the receipt is issued) is not
  in the batch that is running: tests and E2E run the outbox (or `GET /api/cron/outbox`) more than
  once.
- react-email's plain-text output upper-cases headings; match text case-insensitively.
- An admin action must return `revalidate: true` in its effects for the page to re-render after a
  `useActionState` submit.
- `next start` still logs `⨯ Error: The destination stream closed early.` during E2E (see M2
  part 1); harmless.

**Not done here**: disclosure PDF attachment (Tier B, WS6; `test.fixme` in `purchase-il`), the
final order-confirmation/disclosure wording (WS6), admin refund dialogs, retry of FAILED tax
documents, record payment, manual order (WS4), the fulfillment screen and `shipment-update` /
`ready-for-pickup` templates (WS3), Morning/gateway adapters (WS5), link orders and
`checkout-link` (WS2), `admin-alert` emails (WS6).

### M2 acceptance review (independent re-run, 2026-10-01)

**Re-run from a clean state**: `npm ci`, `db:reset` (demo), `npm run verify`, the integration suites
`reserve-race` / `finalize` / `capture-race` / `refunds` (twice), E2E `purchase-il`, `webhook`,
`order-retry`, `race`, `smoke`, then the full E2E suite twice, a manual walkthrough (he + en, 390 and
1280 px: browse → buy with the mock provider, including US/USD → Sold → admin order), and SQL
invariant checks on the E2E database (one live sale per artwork, SOLD ⇔ live sale, PAID orders bound
to one SUCCEEDED attempt of the exact total, totals = items + shipping + insurance, no hold left on
SOLD/closed orders, one receipt per paid attempt, no DEAD/pending outbox jobs, no unprocessed events).

**Fixed during the review**
- The first `order-retry` run failed twice. **Cause:** the order page sent `Referrer-Policy:
  no-referrer`, so browsers send `Origin: null` on its form POSTs. That always happens for a native
  submit (before hydration, or without JS), and per the Fetch spec also for `fetch()`; Chromium
  happens to send the real origin for hydrated `fetch()`. Next's Server Actions CSRF check rejects
  `Origin: null` with a 500 ("Invalid Server Actions request"). **Fix:** the order page uses
  `strict-origin` (header in `next.config.ts` and page metadata): Referer carries only the origin,
  never the path or `?k=`, so the token still cannot leak, and same-origin POSTs keep a real Origin.
  Deviation from §7's "`no-referrer` on token pages", same intent. **Rule for later streams:** never
  put Server Action forms on a `no-referrer` page; print pages keep `no-referrer` (no forms).
- E2E: `ConfirmButton` opens its dialog from a client handler, so a click before hydration does
  nothing. `support/commerce.ts#clickAndConfirm` retries the click until the dialog is visible
  (used by `order-retry` and `webhook`).
- Admin order list: the work column was always "—". Drizzle renders `${orders.id}` inside a
  single-table **select list** as a bare `"id"`, so the correlated subquery compared
  `order_items.order_id` with `order_items.id`. The outer column is now written out
  (`"orders"."id"`) and `admin-orders.test.ts` asserts the titles. **Gotcha:** in WHERE clauses Drizzle
  qualifies columns (`"orders"."id"`), in select lists it does not. `commerce-state.ts#inFlightHoldSql`
  (used in select lists) is correct only because `payment_attempts` has no `reserved_by_order_id`
  column; write outer columns qualified in any new correlated subquery.
- Demo banner: the " / " separator sat inside the English `dir="ltr"` isolate and rendered at the
  far end in Hebrew; it now sits between the two isolates.
- Order page: the cancellation link and "try again" link were not underlined (WCAG 1.4.1).
- Admin order list: cells had no inline padding (the Hebrew "סה״כ" and "סטטוס" headers touched).

**Open items found (not fixed; owners per §9.2)**
- Admin order detail shows raw enums (`CARRIER_TABLE`, `LOCAL_PICKUP`, `SUCCEEDED`,
  `AWAITING_FULFILLMENT`) and, for pickup, shows the country as the "shipping address" (WS4/WS3).
- USD checkout says "insured up to ₪5,800" (insured value in ILS while the buyer pays USD) (WS2/WS3).
- Artwork image captions (English AIC credit lines) are not bidi-isolated on Hebrew pages, so a
  trailing word can wrap onto the far side (WS1: wrap in `<bdi>`/`lang="en"`).
- The checkout postal-code label has neither "(required)" nor "(optional)" (WS2).
- The checkout details form needs JS (only the delivery GET form has a no-JS path); fine per §5.1,
  noted because the order page's forms now work without JS.

### M3 WS5 Integrations notes

**What exists**
- `payments/providers/cardcom.ts` + `cardcom-map.ts`: LowProfile v11 on the generated swagger types.
  `Create` (ReturnValue = attempt id, ISOCoinId 1/2, major-unit Amount, installments only for
  IL + ILS + `maxInstallments > 1`, buyer prefill only in LIVE mode, `Document` only in LIVE gateway
  mode; nullable fields are stripped before sending), `GetLpResult` (succeeded only on the four
  spec conditions, everything else `pending`), HMAC `a`/`t` notification auth without the DB, event
  key `cc:<LowProfileId>:<TranzactionId|none>:<ResponseCode>`, `RefundByTransactionId` (no
  ApiPassword → `manual_required`; any non-zero code → `ProviderRejectedError` → FAILED),
  `ListTransactions` (DDMMYYYY Israeli dates per the swagger, paged, charges only). The HTTP client
  is built on first use and credentials are checked before it, so an unusable terminal fails with
  `ProviderNotConfiguredError` before any network call.
- `payments/providers/paypal.ts` + `paypal-map.ts` + `paypal-verify.ts`: Orders v2 / Payments v2 /
  Webhooks v1. OAuth cached per (mode, client id) until `expires_in - 60` s; a 401 drops the token
  and retries once. Full §4.2 status table; `custom_id` = attempt id, `invoice_id` =
  `<order>-<seq>`, breakdown + items only when they add up to the amount exactly. Capture:
  ORDER_ALREADY_CAPTURED re-reads the order; a 422 that leaves the order APPROVED (declined
  instrument) maps to `failed` so finalize does not loop on `requires_capture`. Refund `custom_id`
  = refund id. `getRefund` without a stored refund id follows the capture's `up` link to the order
  and matches `custom_id`. Verify postback body is concatenated with the raw event verbatim; a
  body that is not one JSON object, a missing transmission header or a missing
  `PAYPAL_WEBHOOK_ID` is rejected without a network call.
- `taxdocs/morning.ts`: token (auth host, `expiresAt` seconds) cached; receipts 400/320, credit
  notes 330 linked to the receipt; marker in `description`; `findByMarker` = search ±7 days with an
  exact description match (the search is fuzzy: `…/RECEIPT/1` vs `…/RECEIPT/10`); PDF via download
  links. `taxdocs/gateway.ts#buildGatewayDocument` implemented.
- `email/drivers/resend.ts`: Resend SDK with `idempotencyKey` = dedupe key; quota/rate/5xx →
  `ProviderUnavailableError` (outbox retries with the same key), other 4xx → rejected.
- `integrations/http.ts`: `recordingFetch` (redacted exchanges, no headers or hosts) and
  `expectData` now reads provider error codes from Cardcom `ResponseCode` and Morning `errorCode`
  too (PayPal `name` as before).
- Scripts: `check:cardcom` (Create ₪1 → GetLpResult → hosted-page language check → negative paths;
  `--record`, `--wait[=s]`, `--locale=en`, `--allow-live`), `check:paypal` (merchant id via
  userinfo → create → approve URL; `--capture=<id>` → capture → refund), `check:morning` (sandbox
  receipt → findByMarker → PDF), `check:dhl` (public api-mock with its demo credentials, then the
  test environment only with credentials). All skip cleanly (exit 0) without credentials; shared
  helpers in `scripts/check-support.ts`. Fixtures are written only with `--record` or
  `RECORD_FIXTURES=1`.
- Tests: `tests/contract/{payment-provider,taxdoc}.suite.ts` (shared), `cardcom`, `paypal`,
  `morning` (+ the mock tax-document provider on the shared suite); unit `cardcom-map`,
  `paypal-map`, `morning-map` (+ gateway builder), `resend-driver` (+ recorder). Replay helper:
  `tests/contract/support/replay.ts`; env helper with the live-credential snapshot:
  `tests/contract/support/env.ts`. Live blocks: `CARDCOM_CONTRACT=1` / `PAYPAL_CONTRACT=1` /
  `MORNING_CONTRACT=1` in the **shell** (not `.env.local`) plus credentials.

**Cardcom live check: BLOCKED by the test-terminal credentials**
- `npm run check:cardcom` and `CARDCOM_CONTRACT=1 npm run test:contract` fail at `LowProfile/Create`:
  HTTP 401 `{"ResponseCode":603,"Description":"שם משתמש או סיסמה שגויים"}` (wrong user name or
  password). The terminal in `.env.local` is the documented public one and the ApiName matches the
  hash in `check-secrets.ts`; two capitalisations were tried, and the legacy
  `Interface/LowProfile.aspx` answers the same 603. So the public test terminal no longer accepts
  these credentials: ask Cardcom for current test-terminal values. The refusal is recorded
  (`tests/fixtures/cardcom/create-rejected.json`, redacted) and covered by the contract suite.
- Consequently the unpaid GetLpResult, the hosted Hebrew page and a test-card payment could not be
  observed live. The other Cardcom fixtures are **synthetic** (`recordedAt: "synthetic"`), built from
  the v11 swagger shapes; re-record with `npm run check:cardcom -- --record` once credentials work
  (it overwrites `create-ok` and `getlpresult-unpaid`; `--wait` adds `getlpresult-paid`).
- Open questions only a live terminal can settle: the actual ResponseCode/shape of an unpaid
  GetLpResult (mapped to `pending` either way), whether Cardcom accepts a localhost `WebHookUrl`, and
  whether the webhook body is JSON (parsed as JSON, form-encoded as a fallback).

**Decisions**
- Cardcom `ProductName` is localized ("ציור מקורי – …" on Hebrew pages) instead of always English.
- Cardcom has no idempotency key: a retried Create makes a second LowProfile, harmless because only
  the stored `provider_ref` is verified.
- Morning `currencyRate` is sent as 1 for ILS and omitted for USD so Morning applies its own rate
  (the generated type marks it required; accountant/sandbox to confirm, spec §12.3). Row VAT:
  murshe 1 (included), patur 0 (by business type), exports 2 (exempt) with document `vatType` 1.
- The Morning credit-note contract carries no VAT mode, so the adapter reads the original document
  first: a 400 (patur receipt) → `TaxDocumentNeedsManualError`.
- PayPal `brand_name` comes from the display name of `EMAIL_FROM` (adapters stay DB-free).

**For other streams (not done here, outside WS5 ownership)**
- WS2: gateway mode end to end needs `checkout/start.ts` to pass `gatewayDocument`
  (`buildGatewayDocument`) into `createCheckout` and `taxdocs/issue.ts` to copy
  `VerifiedPayment.gatewayDocument` (not persisted by `apply.ts` today).
- WS2: PayPal refund/reversal/dispute events carry `refundCustomId` but no attempt id; `webhook.ts`
  currently marks them unmatched instead of calling `syncPostSuccessEvent`.
- WS2: "Bit only for ILS totals ≤ ₪5,000" is a checkout-UI rule on top of `capabilities.wallets`.
- WS3: `check:dhl` exercises only reachability; DHL label/tracking calls are the carrier adapter's.

### M3 WS2 commerce notes

**What exists**
- **Link orders** (`checkout/links.ts`, `link-details.ts`, `link-requests.ts`, `items.ts`):
  `createLinkOrder(input, ctx, deps?)` locks the artwork (reservable with `web=false`, so the
  admin bypasses `quote_only` / `price_on_request`), takes the buyer advisory locks, inserts the
  order (`source` = QUOTE / OFFER / MANUAL, `shipping_locked`, consents empty) and its item,
  reserves for `expiresInHours ?? settings.linkHoursDefault` (1–336 h), expires a taken-over lapsed
  hold, moves the request (QUOTE → QUOTED; OFFER → ACCEPTED at the asked amount, else COUNTERED;
  a QUESTION only gets `order_id`), enqueues `checkout-link` and audits `order.link_created`.
  Rules: IL ⇒ ILS; a price ≠ the list price needs `priceChangeReason` (stored in `admin_notes`
  and the audit row; OFFER exempt); shipping is either `lockedShippingMinor` (method default
  QUOTED, `shipping_locked=true`, no insurance) or the table quote of `shippingMethod` / the
  first ok method (`SHIPPING_QUOTE_REQUIRED` otherwise); `DESTINATION_DENIED` is always refused.
  Conversation: input flag, or detection, or a linked request (`REQUEST:<id>`, else `ADMIN` for
  MANUAL / `LINK`).
- **Order page for link orders**: "Complete your order" (method radios unless locked, address,
  pre-contract disclosure from `documents/data.ts#loadDisclosureInput`, consents) →
  `saveLinkDetailsAction` → `completeLinkOrderDetails` (a method change runs `requoteOrder`;
  `details=saved|requoted`). `startPaymentForOrder` refuses `details_required` for link orders
  until `orderDetailsComplete`. Holds longer than 2 h show a date instead of a countdown.
- **Request lifecycle** (`settleLinkRequests`): PAID → CONVERTED (`apply.ts`); expiry, release,
  takeover (`expireTakenOverOrders`) and LOST_RESERVATION → EXPIRED. This is reconcile step 4's
  "link requests → EXPIRED".
- **Offline payments** (`payments/offline.ts`): `recordOfflinePayment(orderId, input, ctx, deps?)`
  returns `{ attemptId, outcome: "paid" | "needs_refund" }` (additive). Fresh session (30 min,
  `FRESH_SESSION_REQUIRED`), exact total and currency (`AMOUNT_MISMATCH`), order AWAITING_PAYMENT or
  EXPIRED and nothing in flight (`ORDER_NOT_PAYABLE` / `PAYMENT_IN_FLIGHT`), reference required
  except for cash, `receivedAt` not in the future. OFFLINE / MANUAL attempt (`transaction_id` =
  reference) → `applySuccessfulPayment` in the same transaction; `paid_at = receivedAt`. A payment
  that can no longer be applied → NEEDS_REFUND with a MANUAL_REQUIRED refund. Methods `bit` and
  `card` keep their tax-document payment type.
- **Post-success webhooks** (`webhook.ts`): `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` /
  `CUSTOMER.DISPUTE.CREATED` go to `syncPostSuccessEvent` (also on reconcile replay). Attempt
  resolution: event hint → our refund id (`custom_id`) → capture id (refund `up` link or
  `disputed_transactions[0].seller_transaction_id`) → provider ref; none → CRITICAL
  `PAYMENT_EVENT_UNMATCHED`, acknowledged. Outcome stored as `<kind>:<outcome>`.
  **WS5 contract:** the PayPal `parseNotification` must return `eventType = event_type`,
  `refundCustomId = resource.custom_id` and keep in `payloadRedacted` the subset typed as
  `PostSuccessPayload` (`resource.{id,status,amount,custom_id,links,disputed_transactions}`).
- **Cardcom daily checks** (`payments/sweep.ts`): `runCardcomDailyChecks(ctx, deps?)` →
  `{ cardcomTail, cardcomSweep }` for **WS6's `jobs/daily.ts`** to call. Tail: EXPIRED Cardcom
  attempts with `tail_until > now()` not polled in the last 20 h → `finalizeAttempt`. Sweep (live
  mode with `CARDCOM_API_PASSWORD`, or a fixture adapter in tests): `listTransactions` for 3 days,
  matched by transaction id / ReturnValue / LowProfile id; unapplied → finalize; unmatched →
  CRITICAL `UNMATCHED_CARDCOM_TRANSACTION` (deduped per transaction).
- **Gateway tax documents**: in `TAX_DOCUMENTS_MODE=gateway` `launchAttempt` passes
  `gatewayDocument` (built by `taxdocs/issue.ts#gatewayDocumentFor` → WS5's
  `buildGatewayDocument`, still a stub that throws, so a gateway-mode Cardcom checkout fails
  until WS5); `apply.ts` stores `vp.gatewayDocument` in `verified_raw.gatewayDocument`; the
  receipt job copies it (ISSUED, CARDCOM_GATEWAY) or goes NEEDS_MANUAL (PayPal, offline, none).
- **Checkout open items fixed**: the insured value is shown in the order currency
  (`pricing.ts#insuredValueForDisplay`, USD rounded down); optional fields carry "(optional)"
  (the message strings lost their own suffix). Return route: an attempt the webhook already
  cancelled with LOST_BEFORE_CAPTURE reports `payment=lost_before_capture`.
- Registry test seam: `setProviderFactoryForTests(id, factory | null)` (ignored in production).
- `email/props.ts`: the `checkout-link` builder (refId = order id); template is real.

**Tests**
- Integration: `link-orders`, `offline`, `webhook-replay`, `expire-job`, `limits` (new);
  `taxdocs` gained gateway/none cases. The spec's `outbox` scenarios are covered by
  `outbox-core` + `outbox-emails` + `taxdocs` (credit note waits for an UNKNOWN receipt) — run
  `npx vitest run --project integration outbox` to select them.
- Unit: `pricing`.
- E2E: `international`, `late-payment`, `capture-mode`, `tamper` (+ M2's `order-retry`). They buy
  **`e2e-*` clones of demo works** (`support/commerce.ts#cloneWork`, published, sort order 9999,
  never featured): the demo catalog has too few sellable works for parallel specs. Storefront
  specs that count works must ignore `e2e-` slugs. IPs used: `buyerIp(21–27)`.
- Factories: `testAdminContext`, `insertBuyerRequest`, `linkOrder`, `completeDetails`, `payOrder`.

**Gotchas**
- `npm run test:e2e -- --project=desktop-chromium <files>` (with `=`): `--project <name>` makes
  Playwright read the following file paths as more project names.
- The mock sends its webhook before redirecting, so the return route usually sees an attempt the
  webhook already finalized; `buyerOutcome` maps final states (now including the failure reason).
- Lock order extension: `buyer_requests` rows are locked after `orders` (`settleLinkRequests`,
  `linkRequest`).

**Not done / for others**
- Admin UI for link orders, offers, refunds and "Record payment" (WS4 calls `createLinkOrder`,
  `recordOfflinePayment`, `requestRefund`, `confirmManualRefund`, `confirmRefundFailure`,
  `retryRefund`). Offers (Tier B) need only the inbox UI: OFFER links work.
- Calling `runCardcomDailyChecks` from `jobs/daily.ts` (WS6); the real Cardcom
  `listTransactions` / PayPal adapters and `buildGatewayDocument` (WS5).
- No E2E for the link-order page yet (it needs WS4's admin screen to create the order); it was
  checked by hand in he/en at 390 and 1280 px (IL and US links, pay through the mock).

### M3 WS3 notes (shipping and fulfillment)

**What exists**
- `shipping/customs.ts` (description generator, `importCommodityCode` US/EU/IL, EU 2019/880 and
  origin statements, `exportDeclarationRequired` strictly above the USD threshold,
  `declaredValueUsdMinor`); `rates.ts` gained `insuredValueInCurrency` and drops the EU EUR 3
  duty notice outside 2026-07-01..2028-07-01.
- Carriers: `carriers/mock.ts` (waybill `MOCK` + 10 digits = label time in deciseconds since
  2026-01-01, so `track()` is stateless; timeline PU/AF/SA/WC/OK scaled by
  `MOCK_CARRIER_DELIVERY_SECONDS`; PDF label from `minimal-pdf.ts`), `carriers/dhl-map.ts` (pure
  builders that `satisfies` the MyDHL 3.3.2 types, zod response parsing, checkpoint map, redacted
  stored copy), `carriers/dhl.ts` (Basic auth, `x-version: 3.3.2`, `Message-Reference` on every
  call, shipments / tracking / pickups; `ProviderNotConfiguredError` without credentials).
- Services: `shipments.ts` (guards, override, pack, customs, label claim protocol, unknown-label
  resolution, manual tracking and events, handed over, pickup, artist delivery,
  `createShipmentForOrder`, `cancelShipmentForOrder` for WS6), `status.ts` (every status change:
  event row, one buyer email per status, delivery bookkeeping), `tracking.ts` + `jobs/tracking.ts`,
  `fulfillment-view.ts`, `documents.ts`, `checklist.ts`, `settings-form.ts`.
- UI: `/admin/orders/[id]/fulfill`, `/admin/settings/shipping`, `/print/admin/packing-slip/[orderId]`,
  `/print/admin/commercial-invoice/[orderId]`, `components/fulfillment/{ActionForm,PackingPhotos}`.
- Emails: `shipment-update`, `ready-for-pickup` (+ its props builder in `email/props.ts`, refId =
  shipment id). Messages: `shipping`, `emails-shipping`, `documents-shipping`.
- Tests: unit `shipping-customs`, `dhl-builder`, `dhl-map`, `shipping-settings-form` (+ additions to
  `shipping-rates`); contract `carrier.suite.ts` / `carrier.test.ts` (mock, manual, dhl fixtures;
  `DHL_CONTRACT=1` adds a read-only api-mock call); integration `shipments` (15), `tracking-job` (7);
  e2e `fulfill`, `shipping-rules`. Fixtures `tests/fixtures/dhl/*` are synthetic (README there).

**DHL without credentials (probed 2026-10-01, read-only GETs)**
- `express.api.dhl.com/mydhlapi` and `/mydhlapi/test` exist (401 without credentials) – the M1
  hosts are right.
- `api-mock.dhl.com/mydhlapi` answers **only** with DHL's published demo pair
  `demo-key` / `demo-secret` (other pairs → 401, no auth → 500) and returns canned data (one `PU`
  event from 2020, no GMT offset). Good for a reachability smoke test (`DHL_CONTRACT=1`), not for
  contract truth. No POST was sent to it.
- `check:dhl` is WS5's script; it can reuse `createDhlCarrier({ env, baseUrl: DHL_BASES.mock })`.

**Decisions and deviations**
- Guard codes: a refused fulfillment throws `FulfillmentBlockedError` (code `ORDER_NOT_PAID` or
  `FULFILLMENT_BLOCKED`, `block.code` ∈ ORDER_NOT_PAID / FULFILLMENT_BLOCKED / CANCELLATION_ACCEPTED /
  CANCELLATION_PENDING). A RECEIVED cancellation row **or** `fulfillment_blocked_reason =
  PENDING_CANCELLATION` blocks until `overrideCancellationBlock` stores
  `shipments.cancellation_override_reason` (audited). Other block reasons and ACCEPTED
  cancellations are never overridable. The guard reads `cancellations` itself, so it works before
  WS6 sets the flag.
- `shipments.idempotency_key` is a uuid column, so the spec's `<orderId>:<n>` key is stored as a
  name-based UUID (`uuidFromName`, SHA-256, v5 layout). `message_reference` is a new UUID per claim
  (DHL wants 28–36 characters).
- Label outcomes: `ProviderNotConfiguredError` and 4xx `ProviderRejectedError` → PACKED
  (`LABEL_REJECTED`); timeouts, garbled replies, **5xx** and a 201 without a PDF label →
  LABEL_UNKNOWN + WARNING alert `LABEL_UNKNOWN`. A label created but not recordable → LABEL_UNKNOWN +
  CRITICAL. LABEL_UNKNOWN is resolved by "found" (waybill typed in → LABEL_CREATED) or "none"
  (LABEL_UNKNOWN → LABEL_REQUESTED → PACKED, then a new claim n+1). A LABEL_REQUESTED older than 2 min
  can be marked unknown (crash between claim and result).
- `shipments.insured_value_minor` stays in **ILS** (what `apply.ts` writes from the quote). The DHL
  `II` value is converted to the declared currency at label time (`insuredValueInCurrency`, whole
  dollars rounded down).
- Shipper address for DHL: `business_profile` has only free-text addresses, so `shipperFromProfile`
  reads `address.en` as "line 1, city postal code[, Israel]"; unreadable → `SHIPPER_ADDRESS` before
  any claim. The mock carrier uses a demo shipper instead. (Suggestion for M4/WS4: a structured
  shipper address in `business_profile`; not done – frozen settings schema.)
- Packing: required checklist items are the printed disclosure and (without email consent) the
  printed receipt; the rest are recorded guidance. Photos are required for international or insured
  parcels; keys must match the `purpose=packing` key shape. Pickup orders skip packing.
- Manual tracking from the order page (M2 quick form) still auto-packs (AWAITING_FULFILLMENT →
  PACKED → LABEL_CREATED) so `purchase-il` and `admin-orders` keep working; the fulfillment screen is
  the path with the checklist.
- Buyer emails: LABEL_CREATED, IN_TRANSIT, CUSTOMS, OUT_FOR_DELIVERY, DELIVERED, EXCEPTION, RETURNED,
  COLLECTED (`shipment-update`) and READY_FOR_PICKUP (`ready-for-pickup`); PACKED, the label claim
  states and CANCELLED are silent.
- Delivery bookkeeping calls WS6's `cancellationWindow` (eligible group NONE). Until WS6's body
  lands it throws; `status.ts` logs `shipping.cancellation_window_unavailable` and leaves
  `orders.cancellation_window_ends_at` null (the integration test stubs `@/lib/deadlines`).
- Tracking advance is monotonic by rank (LABEL_CREATED < PICKUP_SCHEDULED < IN_TRANSIT < CUSTOMS <
  OUT_FOR_DELIVERY < DELIVERED/RETURNED) plus EXCEPTION and its machine exits; after an exception a
  later checkpoint without a direct edge passes IN_TRANSIT first. Carrier errors stamp
  `last_tracked_at` (retried next hour).
- DHL checkpoint map: common Express codes (PU PL DF AF AR TR → IN_TRANSIT; CR RR CD HP → CUSTOMS;
  WC → OUT_FOR_DELIVERY; OK → DELIVERED; NH BA CA MD RD OH → EXCEPTION; RT → RETURNED; SA CC
  informational). To be checked against DHL's current list once an account exists (go-live).
- Settings editor: flat field names parsed by `shippingSettingsFromForm`; IR, SY and LB cannot leave
  the deny list; "Mark calibrated today" / "Confirm the coverage terms today" stamp the time; FX is
  shown read-only (it lives in `settings.checkout`, WS4's editor); fresh session required.
- E2E arranges its paid orders directly in the E2E database (`e2eArrangePaidOrder`: an
  **unpublished** SOLD work, a paid order with a SUCCEEDED mock attempt bound to quote v1, the ONLINE
  sale, the shipment) instead of buying shared demo works. `shipping-rules` temporarily adds a MOCK
  value cap and raises the GB threshold (E2E runs the mock carrier, which has no cap; no demo work is
  under GBP 135) and restores both.

**Gotchas**
- `npm run typecheck` with the worktree's `NEXT_DIST_DIR` rewrites `tsconfig.json`; running it as
  `NEXT_DIST_DIR=.next-e2e npm run typecheck` uses the pre-registered includes and leaves the tree
  clean.
- React SSR splits adjacent JSX text into separate nodes (`a<!-- --> / <!-- -->b`); print pages
  that tests grep build such strings with a template literal.
- `playwright.request.newContext()` inside a spec that `test.use({ storageState })` still sends the
  admin cookies unless `storageState: { cookies: [], origins: [] }` is passed.

**Not done / for other streams**
- WS4: link the order detail page to `/admin/orders/[id]/fulfill` (the M2 quick tracking form stays);
  the order detail still shows raw shipment enums and the country as the pickup "address" (M2 open
  item) – `shipping.status.*` / `shipping.method.*` hold the labels.
- WS2: the checkout's "insured up to ₪X" for USD orders should use `insuredValueInCurrency(quote)`;
  the buyer order page can show the shipment timeline with the DHL attribution
  (`emails-shipping.update.dhl` text).
- WS6: `cancelShipmentForOrder(tx, orderId, actor)` for accepted cancellations; the daily job's
  "export declaration pending > 7 days" and "unshipped beyond dispatch_days+2" alerts; the 30-day
  purge of DHL raw tracking (`shipment_events.raw`, source POLL).
- P1 (unchanged): the DHL "Request pickup" button (`requestPickup` / `cancelPickup` exist and are
  contract-tested).
