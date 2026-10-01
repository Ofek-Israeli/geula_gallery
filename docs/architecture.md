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
