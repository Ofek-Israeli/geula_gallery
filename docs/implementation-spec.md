# Geula Gallery v1: final implementation plan (revised after the integrity, technical and scope reviews)

## 0. Context

| Item | Value |
|---|---|
| Facts as of | 2026-10-01 |
| Repo | `github.com/Ofek-Israeli/geula_gallery`: public, empty, no commits, `main` unborn (re-checked: `.git` only, nothing else in the folder) |
| Working directory | the repository root |
| Machine | macOS arm64; Node 26.7.0; npm 11.19.0; Homebrew at `/opt/homebrew` |
| Not yet available | PostgreSQL is not installed. gh 2.86.0 is not logged in, and `GH_TOKEN` is not in the shell. Agent shells do not keep state between calls, so the user must add `GH_TOKEN` to their shell profile (the agent shell is initialised from it), or it must be supplied on each push/PR command (§11.1). |

**How this plan was assembled**
- Base: Plan A (lean and buildable).
- From Plan B (integrity): the sales table, a global lock order, DB CHECKs, UNKNOWN-state protocols, price and double-submit guards, the failure-mode table, invariants.
- From Plan C (experience): reservation columns kept apart from sale status, services that never import `next/*`, the catalog and admin UX, ILS-only display, the demo manifest, refunds counted from the notice.
- Revised after three adversarial reviews. The main changes are:
  - quote-version locking on payment attempts;
  - capture claims that can be re-entered;
  - webhook events kept until they are processed;
  - two-phase refund states;
  - `requireAdmin` on every admin page;
  - the FK lock order;
  - a Tier A/B cut line;
  - the ownership gaps between workstreams closed.

---

## 1. Summary and scope

**One app, one database.** A single Next.js 16.3.8 app (App Router, TypeScript) with one PostgreSQL database runs four things:
1. A bilingual public gallery and shop for one Israeli painter (she/her). Hebrew is the RTL default and English is LTR. She sells unique originals to buyers in Israel and abroad. Each work has quantity 1, shows "Sold" after purchase, and can never be sold twice.
2. A Hebrew-first, mobile-friendly admin.
3. Real integrations behind interfaces, each with a mock:
   - payments: Cardcom (primary) and PayPal (secondary);
   - tax documents: Morning (Green Invoice), or Cardcom gateway mode;
   - shipping: DHL Express MyDHL, a manual carrier, and a table-rate engine the painter edits.
4. The Israeli consumer-law flows.

It runs locally on Homebrew postgresql@18, with a deploy guide for Vercel Pro, Neon, Blob and Resend. The demo images are 16 CC0 works from the Art Institute of Chicago (AIC).

### 1.1 Principles (enforced in review and by tests)
1. **Postgres decides money and inventory.**
   - Row locks are taken in one global order. Every row an FK insert will reference is locked *before* that insert.
   - Every conditional UPDATE has its row count checked.
   - Partial unique indexes allow one active sale per artwork and one winning payment per order.
   - CHECKs enforce: an Israeli destination pays in ILS; a demo item never uses a live provider.
   - Each attempt carries the quote version it was created for, and a stale attempt can never pay an order.
   - Caches, timers, sweepers and webhooks never decide state.
2. **One idempotent `finalizeAttempt()`.**
   - Callers: the webhook, the return route, the reconcile cron, the admin "Recheck payment" button.
   - Order of work: re-query the provider with no locks held, verify exactly, then run one short compare-and-set transaction.
   - A verified success always ends as either a sale or a tracked refund.
3. **Exactly-once external effects.**
   - A claim row is written to the DB before every provider call.
   - A timeout becomes UNKNOWN, and is reconciled (query first) before any retry.
   - A call that is in flight is never repeated blindly.
   - Idempotency keys live in our DB.
4. **Redirect-only payments.** PCI scope stays at SAQ-A, and no third-party script runs on our pages.
5. **Fully dynamic rendering.** Availability, price and "Sold" are read from the DB on every request. Data functions still take `locale` explicitly, so Cache Components can be adopted later.
6. **Domain services never import `next/*`.** A thin Next layer runs `after()`, cookies, headers and revalidation. Services run directly in Vitest. Scripts never import jobs; they call the HTTP cron route.
7. **Authorization is checked where data is read.** `requireAdmin()` runs in every admin page, print page, action and route. A layout guard or the proxy is never enough on its own.
8. **Vertical slice first, then parallel workstreams** on frozen contracts with disjoint file ownership.

### 1.2 Scope tiers

**Tier A (must ship; "done" requires all of it)**

*Public site* (`/he` RTL default, `/en` LTR; identical ASCII slugs)
- Home.
- Works: uncropped CSS justified grid; URL-synced filters and sorts; available works first, plus a "Recently sold" strip; archive at `?availability=sold`.
- Artwork page:
  - gallery with lightbox (zoom, counter, Hebrew labels) and specs in cm and inches;
  - live status and ILS price; Buy now / Ask;
  - "Delivery from ₪X" plus estimates per zone;
  - "tracked" always, and "insured" only when the quote actually includes insurance;
  - duties note, 14-day returns note, mobile sticky bar.
- About, contact (general and commission), credits; legal pages (terms, returns and cancellation, shipping and duties, privacy, accessibility statement); localized and global 404.
- A "ביטול עסקה / Cancel a purchase" link in the header and footer of every public page and in the checkout footer.

*Checkout and payments*
- Flow: Buy now → one server-rendered checkout page → an atomic 35-minute hold → full-page redirect to the provider → server-side finalization → order page (countdown, retry, "release my hold").
- Providers:

  | Provider | Role | Testing |
  |---|---|---|
  | `mock` | Hosted page, HMAC-signed webhooks, capture and review modes | Always |
  | `cardcom` | Primary; LowProfile v11 | Live-checked today on the public test terminal |
  | `paypal` | Secondary; Orders v2 full-page redirect; non-IL destinations | Fixtures now; sandbox once the user creates credentials |

- Refunds: automatic (lost, duplicate or stale-quote payments), admin-initiated (cancellations), or manual.
- Offline payments recorded by the admin.
- Live mode: a daily Cardcom ListTransactions sweep (§5.11).

*Tax documents*
- `TAX_DOCUMENTS_MODE` is `mock | morning | gateway | none`.
- A receipt is issued for every captured payment, including payments that are later refunded (a setting the accountant can switch off).
- A credit note is issued for every refund.
- Exactly once is guaranteed by a DB claim plus a search for our marker in Morning.

*Shipping*
- Table rates the painter edits: zones, size classes S/M/L/QUOTE, per-piece rules, time-boxed surcharges, insurance on a capped insured value, and a declared-value cap per carrier.
- Country rules and the DAP notice.
- Methods: CARRIER_TABLE, LOCAL_PICKUP, ARTIST_DELIVERY, QUOTED.
- Carriers: `mock`, `manual`, and `dhl` (built from the OpenAPI types plus fixtures).
- Fulfillment screen: packing checklist and photos (a private upload purpose), customs, export declaration, printable packing slip and commercial invoice.
- Tracking: a cron job plus manual events, with bilingual status emails.

*Link orders.* Quote-on-request and the manual distance order (WhatsApp, phone or email) both create a link order: a single order, held 48 h, at a locked price. Offline payment recording is included.

*Compliance* (final texts need lawyer and accountant sign-off)

| Area | What is built |
|---|---|
| Cancellation flow | One POST form for both regimes: name plus (ID/passport **or** order number) required; then review → confirm; on-screen and email acknowledgement with content, date and time; duplicate notices accepted. |
| Deadlines and fee | 14-day refund deadline counted from the notice, with alerts. 4-month window when eligible and a conversation took place; conversations are detected automatically from earlier buyer requests. Change-of-mind fee suggestion min(5%, ₪100). |
| Disclosure document | HTML page, inline email summary, and a printed copy in the parcel. Required before packing, pickup handover or artist delivery. |
| Checkout | Pre-contract disclosures; click-to-accept with stored versions; 18+ checkbox; DAP acknowledgement; receipt-by-email consent. |
| Seller identity | Shown at checkout, including "Merchant country: Israel". The ID number appears only on noindex pages, in documents and in emails, never on legal pages or the footer. |
| Privacy | An s.11 notice at every form; a retention purge job. |
| Printables | s.4C studio notice. |
| Go-live | Live checkout is refused while blockers exist. |

*Admin*
- Login with database rate limiting; TOTP 2FA, required on any https deployment.
- Dashboard: needs attention, deadlines, works to fulfil, year-to-date turnover (excluding mock and demo).
- Artworks: CRUD with uploads, roles, ordering and required bilingual alt text; publish checklist; offline hold, sale and relist.
- Orders: recheck, refunds, documents, fulfillment, manual order, record payment.
- Inbox (questions and quotes); cancellations; alerts; settings (business, VAT and pricing, checkout, shipping, cancellation); account.

*Demo*
- Site-wide banner; `X-Robots-Tag: noindex` on all routes; /credits.
- Demo items are refused by live providers. In production, mock payments work only for demo items.
- Seed: 16 AIC works with statuses, 3 sample orders, placeholder business profile, painter account.

*Quality*
- Vitest: unit, contract, and integration tests on real Postgres.
- Playwright: desktop Chromium, mobile Chromium for tagged specs, mock providers, a two-context race test, axe.
- Opt-in live checks.
- Docs, `.env.example`, `.github/dependabot.yml`.
- Initial commit on `main`, a feature branch, and a PR.

**Tier B (in this session only once Tier A is green; otherwise listed in the PR)**
- Offers with accept, counter and auto-decline (reuses the link-order machinery).
- Disclosure **PDF** attachment (react-pdf, gated by the M1 spike).
- COA print view.
- Daily `checkInvariants()`; config-drift alerting beyond the basic refusal.
- Mobile E2E project beyond `@smoke`.
- OpenAPI spec-drift check.

**P1 (follow-ups listed in the PR)**
- Blob client uploads (`/api/admin/blob-upload`) and the COA PDF.
- Admin live preview, `/admin/series`, the `site_content` editor, `/admin/dev` tools.
- Medium and year filters.
- DHL "Request pickup" button (the adapter method is Tier A).
- `scripts/privacy-export.ts`.
- GitHub Actions CI (only with `workflow` scope, §11.1); mobile WebKit; a site-default OG image.

### 1.3 Deferred (README "Not yet")
- **Rendering:** Cache Components / PPR.
- **Cart UI:** the schema and reservation SQL already handle n items.
- **Advertising email:** newsletter and "notify me". These are advertising under s.30A; sold or held works offer a 1:1 inquiry instead.
- **EU:** EUR prices and EU targeting (GPSR). The EUROPE zone exists but is disabled and routes to quote.
- **Shipping extras:** DHL live rates and landed cost; DDP; the DHL Unified Tracking API; domestic courier APIs.
- **Payment extras:** Cardcom iframe and J5 SuspendedDeal; PayPal JS SDK and the disputes API (disputes raise an alert and block fulfillment only); other PSPs and Airwallex.
- **Other:** analytics, "view on a wall", carousels, buyer accounts, Vercel WAF and BotID, the actual deployment.

### 1.4 Deliberate deviations from the digest
| Digest | This plan | Why |
|---|---|---|
| `cacheComponents: true` recommended | Classic rendering with `export const dynamic = 'force-dynamic'` in `src/app/[locale]/layout.tsx` and `src/app/sitemap.ts` | The digest's accepted fallback. It removes stale-"Sold" bugs and prerender failures. `next/root-params` needs no flag, `generateStaticParams` is required only with Cache Components, and `force-dynamic` is valid when they are off. |
| PayPal server SDK plus JS SDK | REST via openapi-fetch; full-page redirect to the `payer-action` link | One HTTP pattern for every provider; no third-party script; a static CSP; webhook verification needs raw REST anyway. |
| Disclosure as a PDF | HTML disclosure plus an inline email summary plus a printed copy (Tier A); PDF attachment via `@react-pdf/renderer` 4.9.0 (Tier B, after the M1 spike) | react-pdf 4.9 added bidi support, but Hebrew regressions are still open (#3552, #3459). Flagged for the lawyer. |
| Blob client uploads | Local multipart route with upload purposes (Tier A); Blob client uploads (P1) | Colour fidelity (sharp converts with ICC awareness); the 4.5 MB body limit applies only in production. |
| `documents.mode = external\|gateway\|none` | `TAX_DOCUMENTS_MODE = mock\|morning\|gateway\|none` | Same meaning. |
| Zones, rates and surcharges as tables | Zod-validated JSONB `settings` rows | Fewer tables; every order snapshots its quote. |
| react-hook-form, @t3-oss/env-nextjs, PGlite, jsdom/testing-library, embla, react-photo-album, PayPal SDKs | Not used | Server Actions with zod; real Postgres for all DB tests; CSS scroll-snap and a justified grid; Playwright for UI. |
| Morning "id+secret → 1-hour JWT" | OAuth2 `client_credentials` at `https://api.morning.co/idp/v1/oauth/token` (sandbox `https://api.sandbox.morning.dev`), returning `{accessToken, expiresAt}` | Verified in Morning's OpenAPI. |

### 1.5 Facts verified (2026-10-01)

**Cardcom v11 swagger**
- `LowProfile/Create`:
  - required: TerminalNumber, ApiName, Amount, SuccessRedirectUrl, FailedRedirectUrl, WebHookUrl;
  - optional: ReturnValue, Operation, CancelRedirectUrl, ProductName, Language, ISOCoinId, UIDefinition, AdvancedDefinition (MaxNumOfPayments, ThreeDSecureState), Document.
- `GetLpResult`:
  - request: TerminalNumber, ApiName, LowProfileId;
  - response: ResponseCode, ReturnValue, Operation, TranzactionId, TranzactionInfo{ResponseCode, Amount, CoinId, Last4CardDigitsString, ApprovalNumber, NumberOfPayments, IsAbroadCard, Brand}, DocumentInfo.
- `RefundByTransactionId` needs ApiPassword and supports PartialSum and AllowMultipleRefunds. `ListTransactions` needs ApiPassword.

**Morning**
- Servers: API `https://api.greeninvoice.co.il/api/v1`, sandbox `https://sandbox.d.greeninvoice.co.il/api/v1`.
- Document types: 305, 320, 330, 400.
- `vatType` 0/1/2; payment types 1/2/3/4/5/10/11.
- `/documents/search` filters by `description`.

**PayPal**
- Orders v2 `experience_context` fields as listed in §4.2.
- The refund request supports `amount`, `custom_id`, `invoice_id`, `note_to_payer` (re-checked against `payments_payment_v2.json`).
- `payee` exposes `merchant_id` and `email_address`.

**DHL**
- The 2.7.2 YAML is downloadable. The current portal version is 3.3.2; M1 tries to download it (§4.1).
- There is no shipment-cancel endpoint, and the API has a `Message-Reference` header.

**Tooling**
- create-next-app 16.3.8 refuses a non-allowlisted README.md, so the app is scaffolded in the scratchpad.
- Root params are not available in Server Actions or Route Handlers.
- The default `serverExternalPackages` list includes `@react-pdf/renderer`, `pg` and `sharp`.
- `use-intl` 4.14.8 exists; it is a dependency of next-intl 4.14.8.
- vitest 5.0.3 needs `vite ^6.4 || ^7 || ^8`.
- `@vercel/blob` 2.8.0 supports private stores.

---

## 2. Architecture and directory tree

### 2.1 Request flow
```
Browser ─► src/proxy.ts  (next-intl routing + optimistic admin-cookie redirect for /admin and /print/admin; matcher excludes api,_next,_vercel,dotted)
   ├─ src/app/[locale]/(site)/**          public pages (dynamic)
   ├─ src/app/[locale]/(checkout)/**      checkout + mock-pay (minimal chrome, cancel link footer, noindex)
   ├─ src/app/[locale]/(print)/print/**   buyer printables (?k= token)
   ├─ src/app/[locale]/(print)/print/admin/**  admin printables (requireAdmin in layout AND page)
   ├─ src/app/[locale]/admin/**           admin (requireAdmin in layout AND every page/action/handler)
   └─ src/app/api/**                      auth, webhooks + returns, cron, files, uploads, health
          │  thin: zod-parse → guard → domain service → applyEffects(after(processOutbox), revalidatePath)
          ▼
   src/server/** domain services (server-only, never import next/*) ─► PostgreSQL (Drizzle core builder + pg Pool)
          ├─ storage: .data/uploads/{public,private} (local) | Vercel Blob public + private stores (later)
          └─ providers via typed HTTP (openapi-fetch + generated types): Cardcom · PayPal · Morning · DHL · Resend
```

### 2.2 Layers and rules
| Layer | Path | May use | Must not |
|---|---|---|---|
| Proxy | `src/proxy.ts` | `next-intl/middleware`, `better-auth/cookies` | touch the DB; be the only auth check |
| Next layer | `src/app/**`, `src/server/next/**` | everything; the only place for `next/headers`, `next/cache`, `next/server`, `redirect`, `better-auth/next-js` | inline business rules |
| Domain services | `src/server/**` except `next/` and `auth/options.ts` | DB, provider clients, `src/lib`, `src/emails`, `src/content` | import `next/*`; call providers inside a DB transaction |
| Auth options | `src/server/auth/options.ts` | `better-auth`, `@better-auth/drizzle-adapter`, schema | `server-only`, `next/*`, `process.env` (env is passed in as a parameter) |
| Isomorphic | `src/lib/**` | pure code | secrets, DB, `@/server/*` |
| UI | `src/components/**`, `src/emails/**`, `src/content/**` | `src/lib`, UI libraries | import `@/server/*` |

**File-level rules**
- Every file in `src/server/**` except `auth/options.ts` starts with `import 'server-only'`.
- Services return `{ result, effects }`. `applyEffects()` runs `after(() => processOutbox({ limit: 10 }))` and `revalidatePath('/', 'layout')`.
- Admin service functions that read buyer PII take `ctx: AdminContext`, a branded type that only `requireAdmin()` can produce.
- Every Server Action and route input carries `locale`. Orders store `locale`.
- `src/server/i18n.ts` uses `createTranslator` from **`use-intl/core`** (pinned), never `next-intl`, so emails and documents render outside Next.
- Never wrap `redirect()` or `notFound()` in try/catch.

**Scripts**
- Scripts run as `node --conditions=react-server --env-file-if-exists=.env.local --import tsx scripts/<x>.ts`.
- They never render React and never import `src/server/{jobs,outbox/process,email/render,documents/pdf,next}/**`.
- `scripts/cron.ts` is an HTTP client. It calls `GET ${APP_URL}/api/cron/<job>` with `Authorization: Bearer ${CRON_SECRET}`, and `--watch` loops every minute. It needs `npm run dev` or `npm start` to be running.
- Seeds never enqueue outbox jobs.
- Vitest aliases `server-only` to `tests/stubs/server-only.ts`.

**Transactions and locking**
- Global lock order: **artworks (ORDER BY id) → per-buyer advisory xact locks → orders (ORDER BY id) → payment_attempts → refunds**.
- **Rows that an FK insert will reference are locked `FOR UPDATE` before the insert.** For example, artworks are locked before `order_items` are inserted. Otherwise the insert's implicit `FOR KEY SHARE` lock deadlocks against another transaction's `FOR UPDATE`.
- Refund, cancellation and relist transactions follow the same order: artworks → order → attempt → refund.
- `pg_advisory_xact_lock` is allowed because it is released at commit and safe with pooling. Session advisory locks are not allowed.
- `withTx(fn)` retries SQLSTATE 40P01 and 40001 up to 3 times. Inside a transaction always use `tx`. Use the core query builder only.

**Enforcement.** `tests/unit/architecture.test.ts` checks that:
- the `server-only` header is present;
- `next/*` is imported only in the allowed folders;
- `@/server` is never imported from UI code;
- `process.env` is read only in `src/server/env.ts` and `src/lib/public-env.ts`;
- no physical Tailwind classes are used (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `start-`, `end-`);
- every export of an admin `actions.ts` is wrapped by `adminAction`;
- **every `page.tsx` and `route.ts` under `admin/**`, `print/admin/**` and `api/admin/**` calls `requireAdmin`**;
- scripts do not import jobs, the outbox processor, or rendering code;
- `NODE_TLS_REJECT_UNAUTHORIZED` appears nowhere.

### 2.3 Directory tree
```
.
├── AGENTS.md / CLAUDE.md         create-next-app agents block + project rules (§9.6)
├── README.md  .env.example  .gitignore  .npmrc (save-exact=true)  .nvmrc (24)
├── .github/dependabot.yml
├── biome.json (files.includes excludes src/server/integrations/generated, drizzle, data, openapi)
├── tsconfig.json  next.config.ts  postcss.config.mjs  vercel.json (regions ["fra1"], crons)
├── drizzle.config.ts  vitest.config.ts  playwright.config.ts
├── assets/fonts/                 static OFL TTFs (Assistant, Frank Ruhl Libre) + OFL.txt (react-pdf; traced via outputFileTracingIncludes)
├── data/demo-manifest.json  data/demo-images/<aicId>.jpg   (committed in M2)
├── drizzle/                      generated SQL migrations (integrator-only)
├── docs/{deploy.md, painter-onboarding.md, architecture.md, testing.md}
├── messages/{he,en}/*.json       namespaces + owners in §9.4; merged by src/i18n/namespaces.ts (M1)
├── scripts/
│   ├── env-init.ts db-setup.ts db-migrate.ts db-reset.ts admin-create.ts cron.ts (HTTP client)
│   ├── auth-cli.ts               exports `auth = betterAuth(createAuthOptions(...))` for `npx auth generate`
│   ├── seed/{index.ts (frozen registry: settings, catalog, orders, users), settings.ts, catalog.ts, orders.ts}
│   ├── fetch-demo-images.ts  lib/{parse-aic-dimensions.ts, procedural-painting.ts}
│   ├── gen-api-types.ts  check-secrets.ts  check-{cardcom,paypal,morning,dhl}.ts
├── src/
│   ├── proxy.ts  instrumentation.ts (import '@/server/env' → fail fast)
│   ├── i18n/{routing.ts, request.ts, navigation.ts, namespaces.ts}
│   ├── content/legal/{he,en}/*.tsx, content/legal/versions.ts, content/disclosure.ts (frozen builder signature; WS6 body)
│   ├── emails/{Layout.tsx, templates/*.tsx, index.ts}
│   ├── app/
│   │   ├── globals.css  global-not-found.tsx  robots.ts  sitemap.ts         (NO src/app/layout.tsx)
│   │   ├── [locale]/layout.tsx  [locale]/{not-found.tsx, error.tsx}
│   │   ├── [locale]/(site)/{layout.tsx, page.tsx, works/page.tsx, works/[slug]/page.tsx, works/[slug]/request/page.tsx,
│   │   │                    orders/[number]/page.tsx, cancel/page.tsx, about, contact, credits, legal/[doc]}
│   │   ├── [locale]/(checkout)/{layout.tsx, checkout/[slug]/{page,actions}.tsx, checkout/returned/page.tsx, mock-pay/[ref]/page.tsx}
│   │   ├── [locale]/(print)/{layout.tsx, print/{disclosure/[number], receipt/[number]}}              buyer (?k=)
│   │   ├── [locale]/(print)/print/admin/{layout.tsx, packing-slip/[orderId], commercial-invoice/[orderId], coa/[saleId], studio-notice}
│   │   ├── [locale]/admin/login/{page.tsx, 2fa/page.tsx}
│   │   ├── [locale]/admin/enroll-2fa/page.tsx                    requireAdmin({ allowUnenrolled: true }); outside (panel)
│   │   ├── [locale]/admin/(panel)/{layout.tsx, page.tsx, artworks/**, orders/**, inbox/**, cancellations/**, alerts/**, settings/**, account/**}
│   │   └── api/
│   │       ├── auth/[...all]/route.ts
│   │       ├── payments/[provider]/webhook/route.ts   POST
│   │       ├── payments/[provider]/return/route.ts    GET
│   │       ├── cron/[job]/route.ts                    GET; Bearer CRON_SECRET; 60 s budget
│   │       ├── files/public/[...key]/route.ts  files/private/[...key]/route.ts
│   │       ├── admin/uploads/route.ts                 POST ?purpose=artwork|packing|return (M1)
│   │       ├── admin/blob-upload/route.ts             P1
│   │       └── health/route.ts
│   ├── components/{ui,site,artwork,checkout,orders,admin,fulfillment,docs}/**
│   ├── lib/{money,format,dimensions,countries,il-id,phone,script,routes,vat,deadlines,public-env,auth-client}.ts, lib/validation/*.ts
│   └── server/
│       ├── env.ts log.ts audit.ts i18n.ts golive.ts invariants.ts
│       ├── auth/options.ts                         pure Better Auth options factory
│       ├── db/{client.ts, tx.ts, schema/{enums,auth,catalog,commerce,shipping,compliance,ops,index}.ts}
│       ├── domain/{state-machines.ts, transition.ts, errors.ts, ids.ts}
│       ├── security/{tokens.ts, crypto.ts, rate-limit.ts, limits.ts, ip.ts, redact.ts}
│       ├── next/{auth.ts, guards.ts, actions.ts, effects.ts}
│       ├── settings/{schemas.ts, index.ts}
│       ├── storage/{types.ts, index.ts, local.ts, blob.ts}   media/{ingest.ts, og.ts}
│       ├── catalog/{queries.ts, commerce-state.ts, mutations.ts, publish.ts}
│       ├── checkout/{pricing.ts, quote.ts, requote.ts, reservations.ts, start.ts, links.ts, release.ts, conversation.ts}
│       ├── payments/{types.ts, registry.ts, finalize.ts, apply.ts, capture.ts, refunds.ts, offline.ts, reconcile.ts, webhook.ts, sweep.ts, post-success.ts}
│       │   └── providers/{mock.ts, cardcom.ts, cardcom-map.ts, paypal.ts, paypal-map.ts, paypal-verify.ts}   (M1 stubs)
│       ├── taxdocs/{types.ts, registry.ts, issue.ts, mock.ts, morning.ts, gateway.ts}
│       ├── shipping/{types.ts, rates.ts, rules.ts, quote.ts, customs.ts, registry.ts, shipments.ts, tracking.ts}
│       │   └── carriers/{mock.ts, manual.ts, dhl.ts, dhl-map.ts, minimal-pdf.ts}
│       ├── documents/{data.ts, pdf/{fonts.ts, render.ts, disclosure.tsx, coa.tsx}}
│       ├── email/{types.ts, render.ts, send.ts, drivers/{log.ts, resend.ts}}
│       ├── outbox/{types.ts, enqueue.ts, process.ts, registry.ts,
│       │           handlers/{send-email,issue-tax-document,issue-credit-note,refund-payment,refund-settled}.ts}
│       ├── requests/service.ts  cancellations/{service.ts, fees.ts}  alerts/service.ts
│       ├── jobs/{index.ts, reconcile.ts, outbox.ts, tracking.ts, daily.ts, purge.ts}
│       └── integrations/{http.ts, generated/*.ts}
└── tests/{unit, contract, integration (globalSetup migrates TEST_DATABASE_URL), e2e,
          helpers/{db.ts, mock-webhook.ts, totp.ts, mailbox.ts, race.ts, factories/{core,commerce,shipping,admin,compliance}.ts},
          fixtures/{cardcom,paypal,morning,dhl,aic,images}, stubs/server-only.ts}
```

### 2.4 Rendering
- Every page renders per request (`force-dynamic` in the root layout).
- After admin mutations, the Next layer calls `revalidatePath('/', 'layout')`.
- Correctness never depends on rendering: checkout re-checks the DB, and finalization uses conditional updates.
- Catalog data functions take `locale` explicitly. Live state lives in `catalog/commerce-state.ts`.

### 2.5 Cross-cutting conventions
- **Money:** integer minor units plus `currency` (ILS | USD).
- **Physical units:** lengths in integer mm, weights in integer g. Display in cm (1 decimal) and inches (nearest 1/8 in).
- **Time:** `timestamptz` everywhere. Display, emails and legal deadlines use Asia/Jerusalem calendar days.
- **Identifiers:**
  - orders: `GG-` + 6 Crockford base32 characters;
  - cancellations: `C-` + 6;
  - artworks: `A-YYYY-NNN`;
  - commercial invoices: `CI-<orderNumber>`.
- **Slugs:** must match `^[a-z0-9]+(-[a-z0-9]+)*$`; identical in both locales; immutable after the first publish.

---

## 3. Data model (Drizzle 0.45.3, `src/server/db/schema/*.ts`)

### 3.1 Conventions
- **Keys and timestamps:** `uuid` primary keys with `defaultRandom()`, except `outbox_jobs` and `audit_log` (bigint identity). Every table has `created_at` and `updated_at`.
- **Migrations:** `drizzle-kit generate` produces committed SQL. Partial indexes and CHECKs are declared in the schema.
- **Cyclic foreign keys** (`artworks.reserved_by_order_id → orders`, `orders.paid_attempt_id → payment_attempts → orders`) are written as `.references((): AnyPgColumn => orders.id)` to avoid TS7022.
- **Deletes:** orders are never deleted, only anonymised. FKs to orders use `on delete restrict`.
- **Auth tables** come from the CLI via `scripts/auth-cli.ts`: `user`, `session`, `account`, `verification`, `two_factor`, `rate_limit`.

### 3.2 Enums
| Enum | Values |
|---|---|
| locale / currency | he, en / ILS, USD |
| artwork_sale_status | AVAILABLE, ON_HOLD, SOLD, NOT_FOR_SALE |
| hold_reason | EXHIBITION, CONSIGNMENT, PRIVATE_VIEWING, RESERVED_OFFLINE, OTHER |
| medium | OIL, ACRYLIC, WATERCOLOR, GOUACHE, INK, CHARCOAL, PASTEL, TEMPERA, MIXED_MEDIA, OTHER |
| surface | CANVAS, LINEN, WOOD_PANEL, BOARD, CARDBOARD, PAPER, OTHER |
| orientation / size_bucket | PORTRAIT, LANDSCAPE, SQUARE, PANORAMIC / S, M, L, XL |
| image_role | MAIN, DETAIL, EDGE, BACK, FRAMED, IN_ROOM, PROCESS |
| packaging_type / glazing / size_class | ROLLED_TUBE, FLAT_BOX, STRETCHED_BOX, FRAMED_BOX, CRATE / NONE, GLASS, ACRYLIC / S, M, L, QUOTE |
| order_status / order_source | AWAITING_PAYMENT, PAYMENT_REVIEW, PAID, EXPIRED, CANCELLED, COMPLETED / WEB, OFFER, QUOTE, MANUAL |
| shipping_method / vat_mode | CARRIER_TABLE, LOCAL_PICKUP, ARTIST_DELIVERY, QUOTED / OSEK_PATUR, OSEK_MURSHE |
| payment_provider / provider_mode | MOCK, CARDCOM, PAYPAL, OFFLINE / MOCK, TEST, LIVE, MANUAL |
| attempt_status | CREATED, PENDING, AWAITING_CAPTURE, CAPTURING, PAYMENT_REVIEW, SUCCEEDED, FAILED, CANCELED, EXPIRED, NEEDS_REFUND, REFUNDED |
| refund_reason | CANCELLATION, LOST_RESERVATION, DUPLICATE_PAYMENT, ORDER_CANCELLED, STALE_QUOTE, AMOUNT_MISMATCH, ADMIN, EXTERNAL |
| refund_status | REQUESTED, IN_FLIGHT, PROVIDER_PENDING, UNKNOWN, SUCCEEDED, FAILED, MANUAL_REQUIRED, MANUAL_DONE |
| sale_channel | ONLINE, OFFLINE |
| taxdoc_kind / taxdoc_provider / taxdoc_status | RECEIPT, INVOICE_RECEIPT, CREDIT_NOTE / MOCK, MORNING, CARDCOM_GATEWAY, MANUAL / ISSUING, UNKNOWN, ISSUED, FAILED, NEEDS_MANUAL |
| generated_doc_kind | DISCLOSURE, COA |
| shipment_status | AWAITING_FULFILLMENT, PACKED, LABEL_REQUESTED, LABEL_UNKNOWN, LABEL_CREATED, PICKUP_SCHEDULED, IN_TRANSIT, CUSTOMS, OUT_FOR_DELIVERY, DELIVERED, EXCEPTION, RETURNED, CANCELLED, READY_FOR_PICKUP, COLLECTED |
| carrier / event_source / export_decl_status | MOCK, MANUAL, DHL / MANUAL, POLL, WEBHOOK, SYSTEM / NOT_REQUIRED, REQUIRED, PENDING_CARRIER, RECORDED |
| request_kind / request_status | QUESTION, OFFER, QUOTE / NEW, REPLIED, ACCEPTED, COUNTERED, QUOTED, DECLINED, AUTO_DECLINED, CONVERTED, EXPIRED, CLOSED |
| cancellation_regime / cancellation_status / return_status | IL, EU / RECEIVED, ACCEPTED, REJECTED, CLOSED / NOT_APPLICABLE, AWAITING_RETURN, RECEIVED, INSPECTED_OK, INSPECTED_DAMAGED |
| cancellation_channel / cancellation_reason / eligible_group | WEB, PHONE, EMAIL, REGISTERED_MAIL, IN_PERSON / CHANGE_OF_MIND, DEFECT, NOT_AS_DESCRIBED, NOT_DELIVERED, OTHER / NONE, SENIOR_65, DISABILITY, NEW_IMMIGRANT |
| job_kind / job_status | SEND_EMAIL, ISSUE_TAX_DOCUMENT, ISSUE_CREDIT_NOTE, REFUND_PAYMENT, REFUND_SETTLED / PENDING, RUNNING, DONE, DEAD |
| alert_severity | INFO, WARNING, CRITICAL |

### 3.3 Tables

#### Catalog
**`series`**: `id`, `slug` (unique, CHECK), `name_he`, `name_en`, `sort_order`.

**`artworks`**
- Identity:
  - `id`, `slug` (unique, CHECK);
  - `inventory_number` (unique, `'A-'||to_char(now(),'YYYY')||'-'||lpad(nextval('artwork_inventory_seq')::text,3,'0')`);
  - `is_demo`, `series_id` (set null).
- Text: `title_he`, `title_en`, `description_he`, `description_en`, `year_created` (CHECK 1800–2100), `medium`, `surface`, `medium_detail_he`, `medium_detail_en`.
- Physical: `height_mm`, `width_mm` (> 0), `depth_mm`, `framed`, `frame_*_mm`, `glazing`, `ready_to_hang`, `signed`, `painted_edges`, `coa_included`, `orientation`, `size_bucket` (derived).
- Publication: `is_published`, `published_at`, `featured`, `sort_order`.
- Sale state: `sale_status`, `hold_reason`, `hold_note`, `reserved_by_order_id` (FK orders, **on delete restrict**), `reserved_until`, `sold_at`.
- Pricing:
  - `price_ils_minor`: the consumer total, including VAT when osek murshe;
  - `price_usd_minor`, `price_on_request`, `price_changed_at`, `offers_enabled`, `offer_auto_decline_below_ils_minor`.
- Shipping: `packaging_type`, `can_be_rolled`, `packed_length_mm`, `packed_width_mm`, `packed_height_mm`, `packed_weight_g`, `size_class_override`, `ships_internationally`, `local_pickup_only`, `quote_only`, `dispatch_days` (5).
- Customs: `hs_code` ('9701.91'), `customs_description_en`, `country_of_origin` ('IL'), `declared_value_override_minor`, `max_insurable_value_minor`, `credit_line`.
- CHECKs:
  - `(reserved_by_order_id IS NULL) = (reserved_until IS NULL)`;
  - `reserved_by_order_id IS NULL OR sale_status='AVAILABLE'`;
  - `sale_status <> 'SOLD' OR sold_at IS NOT NULL`;
  - positive prices.
- Indexes: `(is_published, sale_status, sort_order)`, `(series_id)`, partial `(reserved_until) WHERE reserved_by_order_id IS NOT NULL`.

**`artwork_images`**
- Columns: `id`, `artwork_id` (cascade), `role`, `sort_order`, `alt_he`, `alt_en`, `public_key`, `original_key` (private), `og_key`, `width`, `height`, `bytes`, `content_hash`, `blur_data_url`, `dominant_color` (CHECK hex), `credit_line`.
- Indexes: partial unique `(artwork_id) WHERE role='MAIN'`; `(artwork_id, sort_order)`.

#### Commerce
**`orders`**
- Identity: `id`, `number` (unique), `client_request_id` (uuid unique nullable), `source`, `status`, `status_reason` (LOST_RESERVATION | BUYER_CANCELLATION | ADMIN | RELEASED | HOLD_TAKEN_OVER | LINK_EXPIRED | HOLD_EXPIRED | STALE_QUOTE), `locale`, `currency`, `is_demo`.
- Amounts: `items_total_minor`, `shipping_minor`, `insurance_minor`, `total_minor`, `vat_mode`, `vat_rate_bp`, `vat_minor`, `fx_ils_per_unit numeric(12,6)` (reference only).
- **Quote lock:** `quote_version int not null default 1`. It is bumped by every change to items, amounts, currency, shipping method or address-dependent shipping (`checkout/requote.ts`).
- Buyer: `buyer_name`, `buyer_email`, `buyer_phone`, `buyer_company_name`, `buyer_vat_id` (nullable until completed).
- Shipping address: `ship_country char(2) not null`, `ship_name`, `ship_line1`, `ship_line2`, `ship_city`, `ship_region`, `ship_postal_code`, `ship_phone`, `shipping_method`, `shipping_quote jsonb`, `shipping_locked`.
- Consents: `terms_version`, `returns_version`, `privacy_version`, `terms_accepted_at`, `age_confirmed_at`, `duties_notice_version`, `duties_ack_at`, `receipt_email_consent`.
- Compliance:
  - `conversation_took_place bool`;
  - `conversation_source` (text: `REQUEST:<id>` | `LINK` | `ADMIN` | null);
  - `disclosure_version`, `disclosure_sent_at`, `disclosure_handed_over_at`, `delivered_at`, `cancellation_window_ends_at`;
  - `fulfillment_blocked_reason` (PAYMENT_REVIEW | DISPUTE | PAYMENT_REVERSED | EXTERNAL_REFUND | PENDING_CANCELLATION).
- Lifecycle: `expires_at`, `hold_count smallint default 0`, `first_held_at`, `paid_attempt_id`, `paid_at`, `cancelled_at`, `completed_at`.
- Access: `access_version`, `client_ip_hash`, `admin_notes`, `anonymized_at`.
- CHECKs:
  - `total_minor = items_total_minor + shipping_minor + insurance_minor`, all ≥ 0;
  - `ship_country <> 'IL' OR currency='ILS'`;
  - `vat_minor <= total_minor`;
  - `status NOT IN ('PAID','COMPLETED') OR paid_attempt_id IS NOT NULL`.
- Indexes: `(status, expires_at)`, `lower(buyer_email)`, `(client_ip_hash, created_at)`, `(created_at DESC)`.

**`order_items`**
- Columns: `id`, `order_id`, `artwork_id` (restrict), `title_he`, `title_en`, `price_minor`, `currency`, `declared_value_minor`, `snapshot jsonb`.
- Constraint: UNIQUE `(order_id, artwork_id)`.
- Items are immutable after insert. A requote that changes items creates a new order instead.

**`sales`** (the structural one-sale guarantee)
- Columns: `id`, `artwork_id` (restrict), `order_id`, `order_item_id`, `channel`, `price_minor`, `currency`, `is_mock bool`, `sold_at`, `voided_at`, `void_reason`, `created_by`.
- Constraints:
  - **`UNIQUE (artwork_id) WHERE voided_at IS NULL`**;
  - `UNIQUE (order_item_id) WHERE voided_at IS NULL`;
  - CHECK `channel <> 'ONLINE' OR order_id IS NOT NULL`.

**`payment_attempts`**
- Identity: `id` (sent to the provider as ReturnValue / custom_id), `order_id`, `seq` (UNIQUE `(order_id, seq)`, ≤ 5 per order), `provider`, `provider_mode`, `merchant_ref`, `is_demo`, `status`.
- **Quote binding:** `quote_version int not null`, `amount_minor` (> 0), `currency`. Both are copied from the order when the attempt is created.
- Provider references: `provider_ref`, `transaction_id`, `capture_id`, `redirect_url`.
- Idempotency: `create_request_id uuid`, `capture_request_id uuid`, `capture_tries smallint default 0`, `capturing_since`.
- Payment details: `method`, `installments`, `card_last4`, `card_brand`, `is_foreign_card`, `approval_code`, `failure_reason`, `verified_raw jsonb` (redacted).
- Polling: `next_check_at`, `check_count`, `last_checked_at`, `tail_until` (Cardcom: created + 30 days), `finalized_at`.
- Constraints:
  - UNIQUE `(provider, provider_ref) WHERE provider_ref IS NOT NULL`;
  - **UNIQUE `(order_id) WHERE status IN ('CAPTURING','PAYMENT_REVIEW','SUCCEEDED')`**;
  - CHECKs: MOCK ⇒ mode MOCK; OFFLINE ⇒ mode MANUAL; `NOT is_demo OR provider_mode <> 'LIVE'`.
- Index: `(status, next_check_at)`.

**`payment_events`**
- Columns: `id`, `provider`, `event_key`, `event_type`, `attempt_id`, `authenticated`, `payload_redacted`, `received_at`, `received_count int default 1`, **`processed_at` (null until processing succeeded)**, `outcome`, `last_error`.
- Constraint: UNIQUE `(provider, event_key)`.
- Index: partial `(received_at) WHERE processed_at IS NULL`.

**`refunds`**
- Columns:
  - `id`, `attempt_id`, `order_id`, `cancellation_id`;
  - `amount_minor` (> 0), `currency`, `fee_withheld_minor`, `reason`, `status`;
  - `idem_key uuid` (unique), `provider_calls smallint default 0`, `in_flight_until`, `provider_refund_id` (unique when not null), `manual_reference`;
  - `failure_confirmed_at`, `failure_confirmed_by`;
  - `requested_by`, `legal_due_at`, `error`, `completed_at`.
- Constraint: UNIQUE `(cancellation_id) WHERE cancellation_id IS NOT NULL AND NOT (status='FAILED' AND failure_confirmed_at IS NOT NULL)`.
- **Cap rule:** every row counts toward "refunded or possibly refunded" except FAILED rows whose `failure_confirmed_at` is set. An admin sets it after checking the provider dashboard.

**`mock_payments`** (non-production only)
- Columns: `ref`, `attempt_id`, `amount_minor`, `currency`, `flow` (DIRECT | CAPTURE), `state` (OPEN | APPROVED | PAID | REVIEW | DECLINED | CANCELED | REFUNDED | PARTIALLY_REFUNDED), `transaction_id`, `refunded_minor`, `capture_request_ids text[]`, `refund_request_ids text[]`, `return_url`, `cancel_url`, `notify_url`.
- Capture and refund are idempotent per request id.

**`tax_documents`**
- Columns: `id`, `order_id`, `attempt_id`, `refund_id`, `kind`, `provider`, `status`, `marker` (unique, e.g. `GG-7K3M9Q/RECEIPT/1`), `provider_doc_id`, `doc_number`, `doc_type_code`, `allocation_number`, `doc_url`, `file_key`, `attempts`, `last_attempt_at`, `error`, `issued_at`.
- Constraints:
  - UNIQUE `(attempt_id) WHERE kind IN ('RECEIPT','INVOICE_RECEIPT') AND status <> 'FAILED'`;
  - UNIQUE `(refund_id) WHERE kind='CREDIT_NOTE' AND status <> 'FAILED'`.

**`generated_documents`**: `id`, `order_id`, `sale_id`, `kind`, `locale`, `version`, `file_key`, `sha256`; UNIQUE `(order_id, kind, locale, version)`.

#### Shipping
**`shipments`**: one per order.
- Core: `id`, `order_id` (unique), `status`, `method`, `carrier`, `carrier_name`, `service_code`, `adapter_mode`, `tracking_number`, `tracking_url`, `packages jsonb`.
- Declared value and insurance: `declared_value_minor`, `declared_currency`, **`insured_value_minor`** (capped value), `insurance_provider`, `insurance_premium_minor`.
- Customs: `hs_code`, `origin_country`, `contents_description_en`, `reason_for_export`, `incoterm`, `commercial_invoice_number`, `export_declaration_number`, `export_decl_status`.
- Files and checklist: `label_file_key`, `invoice_file_key`, `packing_photo_keys text[]`, `checklist jsonb`.
- Carrier interaction: `pickup_confirmation`, `cost_actual_minor`, `charged_to_buyer_minor`, `idempotency_key` (unique), `label_attempt`, `message_reference`, `provider_shipment_id`, `provider_response_redacted`, `cancellation_override_reason`.
- Timestamps: `shipped_at`, `estimated_delivery_at`, `delivered_at`, `last_tracked_at`, `insurance_claim_deadline_at`.
- Constraint: UNIQUE `(carrier, tracking_number) WHERE tracking_number IS NOT NULL`.

**`shipment_events`**: `id`, `shipment_id`, `occurred_at`, `status` (nullable), `code`, `description`, `location`, `source`, `raw`; UNIQUE `(shipment_id, source, occurred_at, code)`.

#### Compliance
**`buyer_requests`**
- Columns: `id`, `kind`, `topic` (GENERAL | COMMISSION | AVAILABILITY | SIMILAR_WORKS), `artwork_id`, `name`, `email`, `phone`, `country`, `locale`, `message`, `offer_amount_minor`, `offer_currency`, `status`, `order_id`, `admin_reply`, `replied_at`, `ip_hash`.
- Constraint: partial UNIQUE `(artwork_id, lower(email)) WHERE kind='OFFER' AND status='NEW'`.
- Index: `lower(email)`.

**`cancellations`**
- Request: `id`, `number` (unique), `order_id` (nullable), `regime`, `status`, `return_status`, `channel`, `reason`, `full_name`, `id_number_enc` (AES-256-GCM), `id_number_last3`, `order_number_input`, `email`, `phone`, `message`, `eligible_group`.
- Duplicates: **`duplicate_of_id` (nullable FK cancellations), `possible_duplicate bool`.**
- Timing: `received_at` (legal notice time), `ack_sent_at`, `ack_snapshot jsonb` (content with the ID masked to `•••••••12` style, date, time).
- Assessment: `window_ends_at`, `within_window`, `fee_minor`, `refund_amount_minor`, `refund_id`, `refund_due_at` (= `received_at` + 14 days).
- Return and decision: `return_tracking`, `return_received_at`, `inspection_notes`, `decision_reason`, `decided_by`, `decided_at`, `closed_at`.
- **No unique index on `order_id`**: a second notice must never fail. Indexes: `(order_id)`, `(status, refund_due_at)`.

#### Operations
| Table | Columns |
|---|---|
| `outbox_jobs` | `id bigint identity`, `kind`, `dedupe_key` (unique), `payload` (ids only), `status`, `attempts`, `run_after`, `locked_until`, `last_error`, `done_at`; index `(status, run_after)` |
| `email_messages` | `id`, `dedupe_key` (unique), `template`, `to_email`, `locale`, `subject`, `driver`, `provider_message_id`, `status`, `html`, `text` (log driver; purged after 30 days), `attachments`, `order_id`, `sent_at`, `error` |
| `admin_alerts` | `id`, `severity`, `kind`, `entity`, `entity_id`, `params`, `dedupe_key` (unique), `acknowledged_at`, `acknowledged_by` |
| `audit_log` | `id bigint identity`, `at`, `actor`, `action`, `entity`, `entity_id`, `before`, `after` (redacted), `ip_hash` |
| `rate_limits` | `key`, `window_start`, `count`; pk `(key, window_start)` |
| `settings` | `key` pk (business_profile \| checkout \| shipping \| cancellation_policy \| site_content), `value jsonb`, `updated_by` |
| `cron_runs` | `id`, `job`, `started_at`, `finished_at`, `ok`, `stats`, `error` |

### 3.4 One sale per artwork: the layers
1. **Row locks.** `SELECT … FROM artworks WHERE id = ANY($ids) ORDER BY id FOR UPDATE` runs before any dependent insert.
2. **Conditional updates.** The predicate is repeated in `WHERE`, and the row count must equal n.
3. **`sales` partial unique index**, across both channels.
4. **Winner index** on `payment_attempts`.
5. **Quote binding.** An attempt pays the order only if `attempt.quote_version = order.quote_version AND attempt.amount_minor = order.total_minor AND attempt.currency = order.currency`.
6. **Daily `checkInvariants()`** (Tier B):
   - SOLD ⇔ exactly one active sale;
   - every live hold belongs to an AWAITING_PAYMENT or PAYMENT_REVIEW order;
   - every PAID order has exactly one SUCCEEDED attempt;
   - Σ refunds ≤ captured;
   - every captured attempt has a receipt row;
   - every settled refund of a receipted attempt has a credit-note row.

### 3.5 Reservation rules (`checkout/reservations.ts`)
A hold always belongs to an **order** (`reserved_by_order_id`, `reserved_until`, mirrored in `orders.expires_at`). WEB orders get it at "Continue to payment"; link orders get it when the admin issues the link.

**Predicates**
- **In-flight foreign hold.** `EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = a.reserved_by_order_id AND pa.status IN ('CAPTURING','PAYMENT_REVIEW'))`.
- **Reservable for order `$o`.**
  - `a.is_published AND a.sale_status='AVAILABLE'`;
  - and either `a.reserved_by_order_id IS NULL`, or `a.reserved_by_order_id=$o`, or (`a.reserved_until <= now()` AND NOT in-flight foreign hold);
  - WEB checkout additionally requires `NOT quote_only AND NOT price_on_request`.
- **Sellable at finalization for `$o`.**
  - `a.sale_status='AVAILABLE'`;
  - and either `a.reserved_by_order_id IS NULL`, or `= $o`, or (`a.reserved_until <= now()` AND NOT in-flight foreign hold);
  - `is_published` is *not* required, because a late payment for a free but unpublished work is still accepted.

**All or nothing** (one `withTx`)
1. Lock the artworks `ORDER BY id FOR UPDATE` and check the predicate.
2. Take the per-buyer advisory locks: `pg_advisory_xact_lock(hashtext('hold:e:'||lower(email)))` and `('hold:i:'||ip_hash)`, in sorted order.
3. Count anti-hoarding limits under these locks.
4. INSERT or UPDATE the order, and INSERT the items.
5. Run the conditional reserve UPDATE; the row count must equal n.
6. Expire the orders of taken-over expired holds (`HOLD_TAKEN_OVER`, AWAITING_PAYMENT only).
7. Insert the attempt.

**Hold lengths** (`settings.checkout`)
- `reservationMinutes` 35 (at least the provider page lifetime); link orders `linkHoursDefault` 48.
- While a PayPal capture is claimed, reconcile re-extends the hold to `greatest(reserved_until, now()+10 min)` on every pass.
- PAYMENT_REVIEW → `now()+7 days`.
- Extensions use `greatest(...)`. **The one explicit exception** is a review DENIED/FAILED outcome, which sets the hold to `now()+reservationMinutes` (audited).

**Anti-hoarding** (counted inside the transaction)
- At most 2 live WEB holds per email and 3 per IP hash.
- Per artwork, at most 2 holding orders per email and per IP hash in 24 h.
- A 15-minute cooldown after a buyer's own hold on that work lapses.
- Per order: `hold_count ≤ 3`, and WEB re-reserves are refused once `now() > first_held_at + 2 h`.
- At most 5 attempts per order.
- Rate limits: 10 checkout starts per 10 min per IP; 5 per hour per email.
- Holds are created only by the pay action.
- On a 23505 on `client_request_id`, the existing order is resumed.
- Limits come from `security/limits.ts` and are scaled by `RATE_LIMIT_SCALE`. `env.ts` refuses a scale other than 1 when `APP_ENV=production`.

**Display**
- A live hold: "Reserved – on hold for another buyer until HH:MM" (JSON-LD InStock).
- ON_HOLD: "On hold", or "Reserved" for RESERVED_OFFLINE (OutOfStock).
- SOLD: "Sold" (SoldOut).

### 3.6 State machines (`domain/state-machines.ts`)
`transition(tx, machine, id, allowedFrom[], to, patch, actor)` is a conditional UPDATE. It throws `IllegalTransitionError` on 0 rows and writes the audit row in the same transaction.

**Artwork** (`sale_status`; reservation columns are not a status)

| From | To | Trigger / guard |
|---|---|---|
| AVAILABLE | AVAILABLE + hold | checkout start or link issue; reservable |
| AVAILABLE + hold | AVAILABLE | release, expiry or lazy takeover (never while in flight) |
| AVAILABLE | SOLD | finalize success; sellable; `sales` ONLINE |
| AVAILABLE / ON_HOLD | SOLD | admin offline sale; `sales` OFFLINE; overriding a live checkout hold needs explicit confirmation and is refused while in flight |
| AVAILABLE ⇄ ON_HOLD, ⇄ NOT_FOR_SALE | | admin |
| SOLD | AVAILABLE | relist: voids the sale. Online sale: the order is CANCELLED, the refund settled, the return INSPECTED_OK or NOT_APPLICABLE. |
| SOLD | NOT_FOR_SALE | damaged return; sale voided |

Publishing requires the publish checklist. Unpublishing is refused while a live hold exists.

**Order**

| From | To | Trigger |
|---|---|---|
| AWAITING_PAYMENT | PAID | verified success applied (quote bound) |
| AWAITING_PAYMENT | PAYMENT_REVIEW | capture PENDING |
| PAYMENT_REVIEW | PAID / AWAITING_PAYMENT (hold shortened) / CANCELLED (LOST_RESERVATION) | review outcome |
| AWAITING_PAYMENT | EXPIRED | hold lapsed with no in-flight attempt; released; link expired; taken over |
| EXPIRED | PAID | late success while still sellable |
| AWAITING_PAYMENT / EXPIRED / PAYMENT_REVIEW | CANCELLED (LOST_RESERVATION) | success arrived but the work is gone |
| PAID / **COMPLETED** | CANCELLED (BUYER_CANCELLATION / ADMIN) | refund settled (`REFUND_SETTLED` job) |
| PAID | COMPLETED | daily job: delivered or collected; the window has passed (4 months after the window start when `conversation_took_place`, else 14 days); no open cancellation, dispute or pending export declaration |

**Payment attempt**

| From | To | Trigger |
|---|---|---|
| CREATED | PENDING / FAILED | provider session created (`provider_ref` stored before the redirect) / create error |
| PENDING | AWAITING_CAPTURE | approval seen |
| PENDING / AWAITING_CAPTURE / EXPIRED | CAPTURING | capture claim |
| CAPTURING | CAPTURING (re-entry) | reconcile or admin, or `last_checked_at` > 60 s ago; re-check and re-extend |
| AWAITING_CAPTURE / PENDING / CAPTURING | CANCELED | the claim found the work gone or the quote stale (nothing captured); or the capture watch ran out (6 tries or 24 h) |
| CAPTURING | SUCCEEDED / PAYMENT_REVIEW / FAILED | capture result |
| PAYMENT_REVIEW | SUCCEEDED / FAILED | review outcome |
| PENDING / AWAITING_CAPTURE | FAILED / CANCELED / EXPIRED | provider result or watch window |
| any non-final | SUCCEEDED | verified success applied |
| any non-final | NEEDS_REFUND | verified success that cannot be applied |
| NEEDS_REFUND | REFUNDED | refund SUCCEEDED or MANUAL_DONE |
| non-final | REFUNDED | provider reports `refunded` before we finalized (EXTERNAL row) |

**Refund**
- REQUESTED → IN_FLIGHT. This is the claim: commit, then call the provider.
- IN_FLIGHT → SUCCEEDED | PROVIDER_PENDING | FAILED | UNKNOWN (timeout, or the lease expired) | MANUAL_REQUIRED.
- PROVIDER_PENDING → SUCCEEDED | FAILED (poll or webhook).
- UNKNOWN → SUCCEEDED | FAILED (provider confirmed) | MANUAL_REQUIRED.
- MANUAL_REQUIRED → MANUAL_DONE (reference required).
- FAILED → REQUESTED (new `idem_key`), **only after `failure_confirmed_at`**.
- `executeRefund` calls the provider only on a row it moved from REQUESTED to IN_FLIGHT itself.

**Tax document**
- ISSUING → ISSUED | FAILED | UNKNOWN.
- UNKNOWN → ISSUED (found by marker) | ISSUING (confirmed absent) | NEEDS_MANUAL (after 3 inconclusive searches).
- FAILED → ISSUING (admin).

**Shipment**
- Carrier path: AWAITING_FULFILLMENT → PACKED → LABEL_REQUESTED → LABEL_CREATED → (PICKUP_SCHEDULED) → IN_TRANSIT → CUSTOMS → OUT_FOR_DELIVERY → DELIVERED.
- LABEL_REQUESTED → PACKED | LABEL_UNKNOWN.
- LABEL_UNKNOWN → LABEL_CREATED | LABEL_REQUESTED (after the admin confirms no label exists).
- Manual: PACKED → LABEL_CREATED | IN_TRANSIT.
- Pickup: AWAITING_FULFILLMENT → READY_FOR_PICKUP → COLLECTED. Collection requires `disclosure_sent_at` or `disclosure_handed_over_at`.
- Artist delivery: PACKED → OUT_FOR_DELIVERY → DELIVERED (same disclosure guard).
- EXCEPTION ⇄ IN_TRANSIT; EXCEPTION → RETURNED | DELIVERED. Before IN_TRANSIT → CANCELLED.

**Cancellation**
- RECEIVED → ACCEPTED | REJECTED (reason required).
- ACCEPTED → CLOSED when the refund has settled and `return_status` ∈ {NOT_APPLICABLE, INSPECTED_OK, INSPECTED_DAMAGED}.
- A duplicate is closed with `decision_reason='DUPLICATE'`, and only after the admin links it via `duplicate_of_id`.

**Buyer request**
- QUESTION: NEW → REPLIED → CLOSED.
- OFFER (Tier B): NEW → AUTO_DECLINED | DECLINED | ACCEPTED | COUNTERED → CONVERTED | EXPIRED.
- QUOTE: NEW → QUOTED | DECLINED; QUOTED → CONVERTED | EXPIRED.

**Outbox job**
- PENDING → RUNNING → DONE.
- On failure: back to PENDING with backoff `min(2^attempts min, 6 h)`.
- After 8 attempts: DEAD, with a CRITICAL alert.
- A RUNNING job whose lease has expired can be claimed again.

---

## 4. Provider layer

### 4.1 Typed HTTP (`src/server/integrations/http.ts`)
**`createTypedClient<paths>({ provider, baseUrl, fetch, headers, timeoutMs = 15000 })`** wraps openapi-fetch 0.17.0 and adds:
- `AbortSignal.timeout`;
- redacted logging;
- zod checks on the fields we rely on (an unparseable response counts as unknown);
- typed errors: `ProviderTimeoutError` (outcome unknown), `ProviderRejectedError`, `ProviderUnavailableError`, `ProviderNotConfiguredError`.

Only idempotent GETs are retried automatically.

**`npm run gen:api-types`** passes each spec URL or downloaded file to openapi-typescript 7.13.0. openapi-typescript parses YAML itself, so there is no `yaml` dependency. Cardcom JSON goes through a backslash sanitiser first. Output goes to `src/server/integrations/generated/*.ts` (committed), with a header recording the URL, version and sha256.

| Provider | Spec source |
|---|---|
| Cardcom | `https://secure.cardcom.solutions/swagger/v11/swagger.json` |
| PayPal | `checkout_orders_v2.json`, `payments_payment_v2.json`, `notifications_webhooks_v1.json` from `paypal-rest-api-specifications` |
| Morning | `https://developers.morning.co/docs/openapi.bundled.json` |
| DHL | M1 first tries the **3.3.2** spec, from the developer.dhl.com MyDHL API reference download link and the api-mock server. It falls back to the 2.7.2 YAML only if that fails. The version used is recorded in the file header, the PR provider matrix and a go-live blocker ("regenerate DHL types from the current spec"). |

Every adapter is a factory, `createXProvider({ env, fetch })`. Tests inject a fixture-replaying `fetch`. **M1 creates typed stubs for every adapter** (cardcom, paypal, morning, gateway, dhl, resend) that throw `ProviderNotConfiguredError`, so both registries compile on every branch.

### 4.2 Payments (`src/server/payments/types.ts`)
```ts
export type ProviderId = 'mock' | 'cardcom' | 'paypal';
export type VerifiedState = 'pending' | 'requires_capture' | 'review' | 'succeeded' | 'failed' | 'canceled' | 'expired' | 'refunded' | 'partially_refunded';
export interface PaymentCapabilities { currencies: Currency[]; wallets: ('bit'|'apple_pay'|'google_pay')[]; installments: boolean;
  notificationAuth: 'signature' | 'unsigned-requery' | 'none'; requiresCapture: boolean; refunds: 'api' | 'manual'; partialRefunds: boolean; issuesTaxDocuments: boolean }
export interface CreateCheckoutInput { attemptId: string; attemptSeq: number; orderId: string; orderNumber: string; amount: Money;
  lines: { name: string; amount: Money }[]; shipping: Money; insurance: Money;
  buyer: { name: string; email: string; phone?: string } | null;     // null => never send PII (shared test terminal)
  shipTo?: PostalAddress; locale: Locale; returnUrl: string; cancelUrl: string; failUrl: string; notifyUrl: string;
  maxInstallments: number; idemKey: string; gatewayDocument?: GatewayDocumentSpec }
export interface VerifiedPayment { state: VerifiedState; amount: Money | null; echoedReference: string | null; merchantRef: string | null;
  transactionId?: string; captureId?: string; method?: string; installments?: number; last4?: string; brand?: string; isForeignCard?: boolean;
  approvalCode?: string; refundedMinor?: number; gatewayDocument?: { type: string; number: string; url?: string }; rawRedacted: unknown }
export interface PaymentProvider {
  id: ProviderId; mode: 'MOCK' | 'TEST' | 'LIVE'; capabilities: PaymentCapabilities; merchantRef(): string;
  authenticateNotification(n: { headers: Headers; rawBody: string; query: URLSearchParams; ip: string }): Promise<boolean>; // cheap, no DB
  parseNotification(n: { headers: Headers; rawBody: string; query: URLSearchParams }):
    { eventKey: string; eventType?: string; attemptId?: string; providerRef?: string; refundCustomId?: string; payloadRedacted: unknown }; // hint only
  createCheckout(i: CreateCheckoutInput): Promise<{ providerRef: string; next: { kind: 'redirect'; url: string } }>;
  fetchPayment(r: { providerRef: string; attemptId: string }): Promise<VerifiedPayment>;      // authoritative
  capture?(r: { providerRef: string; idemKey: string }): Promise<VerifiedPayment>;
  refund(i: { refundId: string; transactionId: string; captureId?: string; amount: Money; isFull: boolean; idemKey: string;
    priorRefunds: number; invoiceRef: string; reason: string }):
    Promise<{ status: 'succeeded' | 'pending' | 'manual_required'; providerRefundId?: string; rawRedacted: unknown }>;
  getRefund?(r: { providerRefundId?: string; refundId: string; captureId?: string }): Promise<{ status: 'succeeded'|'pending'|'failed'|'not_found'; providerRefundId?: string }>;
  listTransactions?(r: { from: Date; to: Date }): Promise<{ transactionId: string; amount: Money; returnValue?: string; lowProfileId?: string }[]>;
}
```

**Registry (`payments/registry.ts`)**

`checkoutProviders({ currency, destinationCountry, isDemo })`:
- returns the providers in `PAYMENT_PROVIDERS` order, filtered by currency;
- PayPal only for non-IL destinations, unless `settings.checkout.paypalForIsraeliDestinations`;
- `mock` when `APP_ENV≠production`, **or when `APP_ENV=production && DEMO_MODE=true` and the item `is_demo`** (never for real works in production);
- live providers refused for demo items and while go-live blockers exist.

`providerForAttempt(attempt)`:
- builds any provider whose credentials exist;
- on a mismatch of `provider_mode` or `merchant_ref`, refuses, raises a CRITICAL `CONFIG_DRIFT` alert and returns `config_drift`.

**`mock`**
- `createCheckout` inserts `mock_payments` (DIRECT, or CAPTURE when `MOCK_PAYMENT_FLOW=capture` or a test helper selects it) and redirects to `/[locale]/mock-pay/[ref]`.
- The page reads "MOCK PAYMENT – no real money / תשלום הדגמה – ללא חיוב". It shows merchant, amount and order number, and has six Server Action buttons: Pay, Approve only, Mark under review, Decline, Cancel, Pay without returning.
- Webhook: a real HTTP POST to `notifyUrl` with body `{"id":"evt_<uuid>","type":"payment.updated","ref":"<ref>"}` and header `x-mock-signature: t=<unix>,v1=<hex HMAC-SHA256(MOCK_WEBHOOK_SECRET, t+"."+rawBody)>`. It is checked with `timingSafeEqual` and a 300 s tolerance.
- `fetchPayment` reads the row. `capture` and `refund` are idempotent per request id, so a re-capture with the same key is a no-op.
- `getRefund` exists, and a test hook can make the next call time out.

**`cardcom`** (LowProfile v11, `CARDCOM_BASE_URL`)

*createCheckout*: `POST /api/v11/LowProfile/Create`.

| Field | Value |
|---|---|
| `TerminalNumber`, `ApiName` | env |
| `Operation` | `"ChargeOnly"` |
| `ReturnValue` | attemptId |
| `Amount` | `minor/100` |
| `ISOCoinId` | 1 ILS / 2 USD (USD only if `CARDCOM_CURRENCIES` includes it) |
| `Language` | he / en |
| `SuccessRedirectUrl` / `FailedRedirectUrl` / `CancelRedirectUrl` | `${APP_URL}/api/payments/cardcom/return?a=<id>&r=<returnToken>&l=<locale>&s=success\|failed\|cancel` |
| `WebHookUrl` | `${PUBLIC_WEBHOOK_BASE_URL}/api/payments/cardcom/webhook?a=<id>&t=<notifyToken>` |
| `ProductName` | "Original painting – <title> (<orderNumber>)", no PII |
| `AdvancedDefinition` | `{ ThreeDSecureState: CARDCOM_3DS (default "Enabled"), MaxNumOfPayments }`; installments only for IL + ILS + `maxInstallments > 1` |
| `UIDefinition` | buyer prefill only in LIVE mode |
| `Document` | gateway mode only |

- Tokens are HMACs of the attempt id with HKDF keys `'cardcom-notify'` and `'return'`, truncated to 32 characters.
- In `CARDCOM_MODE=test`, no buyer PII is sent at all.

*fetchPayment*: `GetLpResult`.
- `succeeded` only when `ResponseCode===0`, `Operation==='ChargeOnly'`, `TranzactionInfo.ResponseCode===0` and `TranzactionId>0`.
- Then the amount is `Math.round(Amount*100)` (more than 2 decimals is rejected), `CoinId` maps to currency, `echoedReference = ReturnValue`, `merchantRef = TerminalNumber`.
- **Everything else is `pending`.** The live unpaid response is recorded as a fixture.
- Redaction drops CardOwner*, Token, UIValues and CardInfo.

*Notifications*
- `authenticateNotification` is a timing-safe comparison of `t` against the HMAC of `a`. It needs no DB.
- `parseNotification` builds `eventKey = cc:<LowProfileId>:<TranzactionId|none>:<ResponseCode>`.

*refund*: `RefundByTransactionId {ApiName, ApiPassword, TransactionId, PartialSum?, AllowMultipleRefunds}`.
- `AllowMultipleRefunds=false` when `priorRefunds===0`.
- ResponseCode 0 → succeeded. **Any non-zero code → FAILED.** A FAILED refund counts toward the cap until an admin confirms in the Cardcom dashboard, which safely covers "already refunded" responses after a crash.
- No ApiPassword → `manual_required`.

*listTransactions* (live; needs ApiPassword): used by the daily sweep (§5.11). Fixture built from the swagger schema.

*Capabilities*: `wallets` come from `CARDCOM_WALLETS` (comma list, default empty) because wallets are configured on the terminal. Bit is shown only for ILS totals ≤ ₪5,000.

Never set `NODE_TLS_REJECT_UNAUTHORIZED`.

**`paypal`** (`https://api-m.sandbox.paypal.com` | `https://api-m.paypal.com`)
- **OAuth:** client_credentials, cached until `expires_in-60` s.
- **`merchantRef()` = `PAYPAL_MERCHANT_ID`.** This is the business account's payer id; `check:paypal` prints it via `GET /v1/identity/oauth2/userinfo?schema=paypalv1.1`. Finalize compares it with `purchase_units[0].payee.merchant_id`.
- **createCheckout:** `POST /v2/checkout/orders` with header `PayPal-Request-Id: <create_request_id>`. Body:
  - `intent:"CAPTURE"`;
  - `purchase_units[0]`: `custom_id`=attemptId; `invoice_id`=`<orderNumber>-<seq>`; `amount` with `breakdown{item_total, shipping, insurance}` (2-decimal strings); `items[]` with `PHYSICAL_GOODS`; `shipping{name, address}`;
  - `payment_source.paypal.experience_context{return_url, cancel_url, user_action:"PAY_NOW", landing_page:"NO_PREFERENCE", locale, brand_name, shipping_preference: "SET_PROVIDED_ADDRESS" | "NO_SHIPPING"}`.

  The buyer is redirected to the link with `rel==="payer-action"`.
- **fetchPayment:** `GET /v2/checkout/orders/{id}`.

  | PayPal status | VerifiedState |
  |---|---|
  | CREATED, SAVED, PAYER_ACTION_REQUIRED | pending |
  | APPROVED | requires_capture |
  | capture COMPLETED | succeeded |
  | capture PENDING | review |
  | capture DECLINED / FAILED | failed |
  | capture REFUNDED / PARTIALLY_REFUNDED | refunded / partially_refunded |
  | VOIDED | canceled |

- **capture:** `POST …/capture` with `PayPal-Request-Id: <capture_request_id>` and `Prefer: return=representation`.
- **refund:** `POST /v2/payments/captures/{captureId}/refund` with `PayPal-Request-Id: <idem_key>`. Body `{ amount, custom_id: refundId, invoice_id: "<orderNumber>-R<n>" }`. `custom_id` is used rather than `note_to_payer`, which the buyer sees.
- **getRefund:** `GET /v2/payments/refunds/{id}`. Within 6 h of the original request, re-posting with the same `PayPal-Request-Id` is also safe.
- **Notifications:**
  - per-IP rate limit, then the verify-webhook-signature postback. Its body is built by string concatenation so the raw event is embedded byte for byte.
  - `eventKey` = `event.id`. For refunds, `refundCustomId` = `resource.custom_id`.
- **Events:**
  - `PAYMENT.CAPTURE.COMPLETED`, `DENIED`, `PENDING` → finalize;
  - `REFUNDED`, `REVERSED`, `CUSTOMER.DISPUTE.CREATED` → `syncPostSuccessEvent`.
- **Guest card:** the UI promises only "PayPal (account, or card where PayPal offers it)".

**Offline payments.** `recordOfflinePayment(orderId, { method, amountMinor, currency, reference, receivedAt }, ctx)`:
- requires a fresh session;
- requires **`amountMinor === order.total_minor` and `currency === order.currency`** (otherwise refused; the admin can requote the order first);
- inserts an OFFLINE / MANUAL attempt with the order's `quote_version` and applies it;
- refunds for offline payments are always MANUAL_REQUIRED.

### 4.3 Tax documents (`src/server/taxdocs/types.ts`)
```ts
export interface TaxDocumentProvider { id: 'mock' | 'morning' | 'gateway' | 'none';
  issueReceipt(i: { marker: string; orderNumber: string; vatMode: VatMode; zeroRatedExport: boolean; language: Locale; currency: Currency;
    client: { name: string; country: string; taxId?: string; companyName?: string; address?: string };
    lines: { description: string; unitPriceMinor: number; quantity: 1 }[];
    payment: { type: 'card'|'bit'|'apple_pay'|'google_pay'|'paypal'|'transfer'|'cash'|'cheque'|'other'; amountMinor: number; date: string; reference: string; last4?: string; installments?: number } }): Promise<IssuedDocument>;
  issueCreditNote(i: { marker: string; originalProviderDocId: string; amountMinor: number; currency: Currency; language: Locale; reason: string }): Promise<IssuedDocument>;
  findByMarker?(marker: string, around: Date): Promise<IssuedDocument | null>;
  getPdf?(providerDocId: string): Promise<Uint8Array> }
```

**Modes** (each payment is documented exactly once)

| Mode | Behaviour |
|---|---|
| `mock` | Number `DEMO-000123`; HTML view at `/[locale]/print/receipt/[number]?k=`, stamped "DEMO – not a tax document / הדגמה – אינו מסמך חשבונאי". |
| `morning` | See below. |
| `gateway` | Cardcom `Document {DocumentTypeToCreate: patur ? "Receipt" : "TaxInvoiceAndReceipt", Name, Email (consent only), IsSendByEmail: consent, IsVatFree: patur \|\| export, TaxId?, Products, ExternalId: orderNumber, Language}`. The job copies `gatewayDocument` from the verified payment. PayPal, offline payments and gateway credit notes become NEEDS_MANUAL. Env refuses gateway with `CARDCOM_MODE=test`. |
| `none` | NEEDS_MANUAL; DEMO_MODE only. |

**Morning**
- Token: `POST {authBase}/idp/v1/oauth/token`, cached until 60 s before expiry.
- `POST {apiBase}/documents`:
  - `type` 400 (patur) or 320 (murshe); `lang`, `currency`;
  - `vatType` 0, or 1 for zero-rated exports (accountant confirms);
  - `description = marker`; `remarks` (order number and cancellation channels);
  - `client{name, country, taxId, add:false}`, `income[]`;
  - `payment[]` types: 3 card (with last4 and installments), 5 PayPal, 10 app (appType 1 Bit / 6 Apple Pay / 5 Google Pay), 4 transfer, 1 cash, 2 cheque, 11 other;
  - `signed: true`.
- Dedupe: `findByMarker` → `POST /documents/search {description, fromDate, toDate}`.
- PDF: `GET /documents/{id}/download/links`, copied into private storage.
- Credit note: type 330 with `linkedDocumentIds` (murshe); patur → NEEDS_MANUAL.

**Which payments get a receipt** (`taxdocs/issue.ts`)
- Every verified captured payment gets a receipt: SUCCEEDED attempts, **and** NEEDS_REFUND attempts other than AMOUNT_MISMATCH.
- This is controlled by `settings.checkout.receiptForRefundedPayments` (default true; the accountant may turn it off).
- When a refund settles, a credit note follows.

**Exactly once**
1. Insert `tax_documents(ISSUING, marker)` before the call.
2. Timeout or 5xx → UNKNOWN.
3. Retry (≥ 5 min later): `findByMarker` first. Found → ISSUED; confirmed absent → ISSUING again; 3 inconclusive searches → NEEDS_MANUAL plus an alert.
4. A clear 4xx → FAILED (admin retry).
5. On success: the `receipt` email when consent was given; otherwise "print the receipt" is added to the checklist.

**Credit-note handler.** While the receipt is ISSUING or UNKNOWN, it reschedules itself with backoff. It becomes NEEDS_MANUAL only if the receipt ends FAILED or NEEDS_MANUAL.

### 4.4 Shipping
**Rate engine.** `shipping/rates.ts` and `shipping/rules.ts` are pure.
```ts
export function classify(a: ArtworkShipSpec, divisor = 5000): { sizeClass: SizeClass; chargeableG: number; oversizePiece: boolean; nonConveyable: boolean; reasons: string[] };
export function quoteShipping(i: { items: ArtworkShipSpec[]; country: string; method?: ShippingMethod; currency: Currency; date: Date;
  declaredValueIlsMinor: number; settings: ShippingSettings; fx: FxReference; carrier: 'DHL'|'MANUAL'|'MOCK' }): ShippingQuoteResult; // includes insuredValueMinor, insured: boolean
export function zoneEstimates(a: ArtworkShipSpec, settings: ShippingSettings, date: Date): Record<ZoneId, { fromIlsMinor: number; insured: boolean } | 'QUOTE' | 'UNAVAILABLE'>;
export function evaluateDestination(i: { country: string; declaredValueIlsMinor: number; carrier: 'DHL'|'MANUAL'|'MOCK'; settings: ShippingSettings; fx: FxReference }):
  { mode: 'ok' | 'quote_only' | 'blocked'; reason?: BlockReason; notices: NoticeCode[] };
export type BlockReason = 'DESTINATION_DENIED'|'ZONE_DISABLED'|'NOT_INTERNATIONAL'|'QUOTE_ONLY'|'SIZE_QUOTE'|'VALUE_CAP'|'GB_LOW_VALUE';
export type NoticeCode = 'DAP_DUTIES'|'EU_LOW_VALUE_DUTY'|'US_DUTY_FREE_CLEARANCE_FEES'|'US_FORMAL_ENTRY'|'TRANSIT_ESTIMATE';
```

*Weight and size classes*
- Chargeable weight = max(actual, L×W×H/5000), using packed cm and kg.
- Classes use **packed** dimensions sorted L ≥ W ≥ H. A per-artwork override always wins.

| Class | Rule |
|---|---|
| S | longest ≤ 50 cm and chargeable ≤ 5 kg |
| M | longest ≤ 100, second ≤ 80, chargeable ≤ 20 kg |
| L | oversize piece up to 45 kg chargeable; the base price includes the oversize fee |
| QUOTE | CRATE, glazing ≠ NONE, actual ≥ 25 kg, chargeable > 45 kg, or `quote_only` |

- The oversize fee applies when the class is overridden below L. Non-conveyable (25–70 kg actual) applies when overridden. Over 70 kg is always QUOTE.

*Price*
- `classRatesIls[zone][class]` + per-piece fees + active surcharges (`enabled && startsOn ≤ date ≤ endsOn` inclusive; PCT or FIXED; ALL or listed zones) + insurance.
- **Insurance:** `insuredValue = min(declared value, max_insurable_value_minor ?? ∞, insurance.maxInsuredIls)`, then `premium = max(ratePct × insuredValue, minIls)`.
  - It is included only when `insurance.enabled` and the carrier or method supports it. The quote carries `insured: boolean` and `insuredValueMinor`.
  - Pickup and the manual domestic carrier are uninsured unless the painter sets otherwise.
- USD orders convert shipping and insurance once with the dated `settings.checkout.fx.ilsPerUsd`, rounded up to whole dollars, and lock the result.

*Rolled tube*
- Only if `can_be_rolled`.
- Tube length = the shorter artwork side + 100 mm; cross-section 260 × 260 mm (≥ 10 in diameter); oversize above 100 cm.
- The admin hint says rolling is roughly 2–3× cheaper than boxing.

**Country rules**
- **Zones:** IL; EUROPE = EU27 + GB + CH + NO (disabled by default → quote); NORTH_AMERICA = US + CA; REST_OF_WORLD.
- **Blocks:**
  - the deny list (IR, SY, LB, IQ; IQ removable) is blocked and hidden from the selector;
  - `quoteOnlyCountries`;
  - a disabled zone → ZONE_DISABLED;
  - `!ships_internationally` or `local_pickup_only` abroad → NOT_INTERNATIONAL;
  - GB including Northern Ireland ≤ GBP 135 → GB_LOW_VALUE;
  - declared value above the carrier cap → VALUE_CAP (DHL default USD 2,500 in settings; FedEx is not used).
- **Notices:**
  - DAP duties for every international order (acknowledged; version and timestamp stored);
  - EU ≤ EUR 150: the temporary EUR 3 duty (2026-07-01 to 2028-07-01);
  - US: HS 9701.91 is duty-free and exempt from the 2026 Section 301 tariffs on Israel; de minimis suspended; carrier clearance fees may apply;
  - US > USD 2,500: the buyer is importer of record (formal entry, CBP Form 5106).
- **Addresses:** Latin script internationally (`/^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u`); Hebrew allowed domestically; recipient phone and email required.

**Methods**
- CARRIER_TABLE: IL uses the manual domestic courier; international uses DHL, or manual when DHL is disabled.
- LOCAL_PICKUP: free; the address is revealed after payment.
- ARTIST_DELIVERY: IL only, at a set price.
- QUOTED: link orders only.

**Customs**
- HS 9701.91; extensions US 9701.91.0000, EU 97019100, IL 9701910000.
- English description generator.
- EU Reg 2019/880 "not concerned" statement.
- Export declaration REQUIRED above USD 200; recorded as RECORDED or PENDING_CARRIER.

**Carriers**
```ts
export interface CarrierAdapter { id: 'mock' | 'manual' | 'dhl'; mode: 'mock' | 'manual' | 'test' | 'live';
  capabilities: { rates: boolean; labels: boolean; pickup: boolean; tracking: boolean; landedCost: boolean; paperlessTrade: boolean; insurance: boolean };
  createShipment?(r: CreateShipmentRequest, ctx: { idempotencyKey: string; messageReference: string }):
    Promise<{ waybill: string; trackingUrl: string; labelPdf: Uint8Array; invoicePdf?: Uint8Array; providerShipmentId?: string; rawRedacted: unknown }>;
  requestPickup?(r: PickupRequest): Promise<{ confirmationNumber: string }>;
  cancelPickup?(confirmationNumber: string): Promise<void>;
  track?(waybill: string): Promise<{ events: NormalizedTrackingEvent[]; deliveredAt?: string }>;
  trackingUrl(waybill: string, locale: Locale): string }
```

| Carrier | Behaviour |
|---|---|
| mock | Waybill `MOCK` + 10 digits. A hand-written ASCII PDF label. A deterministic timeline scaled by `MOCK_CARRIER_DELIVERY_SECONDS`. |
| manual | No label. Carrier name, number and URL entered by hand; manual events. |
| dhl | Described below. |

**DHL**
- Bases: `…/mydhlapi/test` (500 calls/day; credentials for active customers only) and `…/mydhlapi`.
- Auth: Basic auth plus a stored `Message-Reference` on every call.
- `POST /shipments`:
  - `productCode "P"`, the shipper account, Latin `customerDetails`, packages (cm/kg), `isCustomsDeclarable`, declaredValue and currency, `incoterm "DAP"`;
  - `exportDeclaration.lineItems` with outbound commodity code `9701910000` and the inbound code per destination, `exportReasonType "permanent"`, `manufacturerCountry "IL"`; invoice `CI-<orderNumber>`;
  - `valueAddedServices`: `II` when insured; `WY` only if `DHL_PAPERLESS_TRADE=true`;
  - label plus DHL commercial invoice; `customerReferences` = the order number.
- Other operations: tracking (`trackingView=all-checkpoints`), `POST /pickups`, `DELETE /pickups/{n}`.
- `dhl-map.ts`: unknown codes record an event and never change the status.
- There is no idempotency key and no cancel, so labels use the LABEL_UNKNOWN protocol (§5.5).
- Registry: `SHIPPING_CARRIER` (mock | manual | dhl); `DHL_EXPRESS_MODE` (disabled | test | live).
- The opt-in check first tries the public `https://api-mock.dhl.com/mydhlapi`, and falls back to fixtures.

### 4.5 Email
- **Sender:** `EmailSender.send({ to, subject, html, text, attachments?, replyTo?, idempotencyKey })`.
- **Drivers:**
  - `log`: stores html and text in `email_messages`;
  - `resend` (6.31.0): Idempotency-Key = the dedupe key; region eu-west-1.
- **Templates:** react-email 6.11.0 components from `"react-email"`; `render` is verified at install, with `@react-email/render` 2.1.0 as the fallback. `Layout` sets `lang`/`dir` and has a footer with seller identity (no ID number), cancellation channels and the order link.
- **Template ids:**
  - Buyer: `order-confirmation`, `payment-review`, `purchase-not-completed`, `shipment-update`, `ready-for-pickup`, `receipt`, `checkout-link`, `request-ack`, `request-reply`, `cancellation-ack` (ID masked), `return-instructions`, `refund-issued`.
  - Painter (Hebrew): `painter-new-order`, `painter-new-request`, `painter-cancellation` (ID masked), `admin-alert`.
- No advertising email exists.
- **Enqueueing:** `enqueueEmail(tx, { template, to, locale, refId })` with dedupe key `email:<template>:<refId>:<to>`.

### 4.6 Storage and images
- **Interface:** `StorageAdapter { put(key, body, { contentType, access, cacheControl? }); get(key, access); delete(key, access); publicUrl(key); signedPrivateUrl(key, ttlSec) }`.
- **local driver:**
  - writes `.data/uploads/{public,private}`;
  - `publicUrl` is relative (`/api/files/public/<key>`), with immutable caching;
  - path traversal rejected;
  - private files via admin session or a signed URL (`exp ≤ 10 min`), served `private, no-store`, attachment.
- **blob driver** (2.8.0): a public store for web masters and OG images; a private store for originals, labels, invoices, packing and return photos, PDFs and receipts.
- **Uploads (M1, frozen contract):** `POST /api/admin/uploads?purpose=artwork|packing|return` (multipart; `requireAdmin` plus same-origin; JPEG/PNG/WebP; ≤ 30 MB; returns `{ fileKey, imageId? }`).
  - `artwork`: full ingest (public master, private original, OG for MAIN).
  - `packing` and `return`: **private only**, with `.rotate()`, metadata stripped and downscaled to 2400 px. No public master.
  - Callers attach the returned keys through Server Actions (keys only, never bytes).
- P1: Blob client upload.
- **Ingest** (sharp 0.35.5):
  - accept only JPEG, PNG and WebP; `limitInputPixels 100M`;
  - ICC-aware conversion to sRGB, EXIF and GPS stripped (tested);
  - master with long side ≤ 2400 px, q85 mozjpeg;
  - 16 px WebP blur, dominant colour;
  - 1200×630 text-free OG image.
  - AIC URLs never go through next/image.

### 4.7 Settings (zod JSONB rows)
- **`business_profile`**:
  - `legalName`, `tradeName`, `artistName`, `signatureName`;
  - `idNumber` (noindex pages, documents and emails only; never passed to legal pages or the footer);
  - `vatMode`, `vatNumber?`;
  - `address{he,en}`, `returnAddress{he,en}`, `phoneLocal`, `phoneIntl`, `email`, `notificationEmail`, `accessibilityContact`, `privacyContact`;
  - `pickupAddress{he,en}`, `pickupInstructions{he,en}`;
  - `completed`.
- **`checkout`**:
  - `reservationMinutes` 35, `linkHoursDefault` 48;
  - `maxActiveHoldsPerEmail` 2, `maxActiveHoldsPerIp` 3, `maxHoldsPerArtworkPerBuyer24h` 2, `holdCooldownMinutes` 15, `maxHoldCountPerOrder` 3, `maxWebHoldSpanMinutes` 120, `maxAttemptsPerOrder` 5;
  - `maxInstallments` 1; `paypalForIsraeliDestinations` false; `receiptForRefundedPayments` true;
  - `conversationLookbackDays` 365;
  - `fx{ilsPerUsd, ilsPerEur, ilsPerGbp, asOf}`.
- **`shipping`**:
  - `divisor` 5000, `calibratedAt`;
  - `zones[{id, enabled, countries, estimate{he,en}}]`;
  - `classRatesIls`, `oversizeFeeIls`, `nonConveyableFeeIls`, `surcharges[…]`;
  - `insurance{enabled, provider: 'DHL'|'THIRD_PARTY'|'NONE', ratePct, minIls, maxInsuredIls, coverageConfirmedAt}`;
  - `valueCaps[{carrier, maxUsd}]`, `deniedCountries`, `quoteOnlyCountries`;
  - thresholds `gbLowValueGbp` 135, `euLowValueEur` 150, `usFormalEntryUsd` 2500, `exportDeclarationUsd` 200;
  - `localPickup`, `artistDelivery`, `domesticCarrierName`.
- **`cancellation_policy`**: `changeOfMindFee: 'STATUTORY_MAX' | 'NONE'` (a suggestion; the admin may only lower it).
- **`site_content`**: P1.
- **Constants:** `src/lib/vat.ts` (`VAT_RATES=[{from:'2025-01-01', rateBp:1800}]`, `PATUR_CEILING={2026: 12_283_300}`). `versions.ts` with `approved:false` shows a DRAFT banner.

### 4.8 Environment variables
`src/server/env.ts` validates everything with zod at boot via `instrumentation.ts`. `src/lib/public-env.ts` covers `NEXT_PUBLIC_*`.

| Group | Variables |
|---|---|
| Core | `APP_ENV` (development \| test \| production; never use NODE_ENV for policy), `APP_URL`, `PUBLIC_WEBHOOK_BASE_URL` (**optional; derived as `?? APP_URL`; env:init does not write it**), `APP_SECRET` (≥ 32 bytes), `PII_ENCRYPTION_KEY`, `DEMO_MODE`, `NEXT_DIST_DIR` |
| Database | `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `E2E_PORT` (3100) |
| Auth | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (**optional; derived `?? APP_URL`**), `ADMIN_REQUIRE_2FA` (forced true when `APP_URL` is https or `APP_ENV=production`), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (scripts only), `SEED_E2E_USERS` |
| Abuse | `RATE_LIMIT_SCALE` (1; E2E 100; must be 1 in production), `FORM_MIN_AGE_MS` (3000; E2E 0; ≥ 3000 in production) |
| Cron | `CRON_SECRET` |
| Payments | `PAYMENT_PROVIDERS`, `MOCK_WEBHOOK_SECRET`, `MOCK_PAYMENT_FLOW` |
| Cardcom | `CARDCOM_MODE` (disabled \| test \| live), `CARDCOM_BASE_URL`, `CARDCOM_TERMINAL_NUMBER`, `CARDCOM_API_NAME`, `CARDCOM_API_PASSWORD`, `CARDCOM_CURRENCIES` (ILS), `CARDCOM_3DS` (Enabled), `CARDCOM_WALLETS` (empty), `CARDCOM_LATE_WATCH_HOURS` (72), `CARDCOM_TAIL_DAYS` (30). **Test-terminal values only in `.env.local`.** |
| PayPal | `PAYPAL_MODE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID` |
| Tax docs | `TAX_DOCUMENTS_MODE`, `MORNING_MODE`, `MORNING_CLIENT_ID`, `MORNING_CLIENT_SECRET` |
| Shipping | `SHIPPING_CARRIER`, `DHL_EXPRESS_MODE`, `DHL_API_KEY`, `DHL_API_SECRET`, `DHL_ACCOUNT_NUMBER`, `DHL_PAPERLESS_TRADE`, `DHL_OPENAPI_URL`, `MOCK_CARRIER_DELIVERY_SECONDS` |
| Email | `EMAIL_DRIVER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` |
| Storage | `STORAGE_DRIVER`, `LOCAL_STORAGE_DIR`, `BLOB_READ_WRITE_TOKEN`, `BLOB_PRIVATE_READ_WRITE_TOKEN`, `NEXT_PUBLIC_BLOB_HOST` |
| Demo | `AIC_USER_AGENT` ("geula-gallery-demo (https://github.com/Ofek-Israeli/geula_gallery)") |
| Opt-in tests | `CARDCOM_CONTRACT`, `PAYPAL_CONTRACT`, `MORNING_CONTRACT`, `DHL_CONTRACT`, `RECORD_FIXTURES` |

**Cross-field rules (fail at boot)**
- `DEMO_MODE=true` ⇒ no `*_MODE=live`.
- `APP_ENV=production && DEMO_MODE=false` ⇒ no mock provider, `TAX_DOCUMENTS_MODE ∈ {morning, gateway}`, `SHIPPING_CARRIER≠mock`, resend, blob, 2FA, secrets ≥ 32 bytes.
- `CARDCOM_MODE=live` ⇒ ApiPassword set and `DEMO_MODE=false`.
- `CARDCOM_MODE=test` ⇒ not gateway.
- `PAYPAL_MODE≠disabled` ⇒ `PAYPAL_MERCHANT_ID` set.
- `APP_ENV=test` ⇒ the hosts of `BETTER_AUTH_URL` and `PUBLIC_WEBHOOK_BASE_URL` equal `APP_URL`'s.

### 4.9 How each adapter is tested
| Adapter | Always (offline) | Live, opt-in |
|---|---|---|
| mock payment / carrier / taxdocs | Shared contract suites `tests/contract/{payment-provider,carrier,taxdoc}.suite.ts` | – |
| Cardcom | Request builder: ReturnValue, ISOCoinId, installments only for IL+ILS, no PII in test mode, decimals. GetLpResult map: success ILS/USD, unpaid, declined, every mismatch. Token auth. Redaction. Refund: `AllowMultipleRefunds`, non-zero → FAILED, no ApiPassword. ListTransactions parsing (from the schema). | **Today:** `CARDCOM_CONTRACT=1 npm run test:contract` and `npm run check:cardcom` (Create ₪1 → GetLpResult unpaid → redacted fixture; `--wait` for a human test payment). Refunds, ListTransactions and gateway documents need a real terminal's ApiPassword. |
| PayPal | Every order state; capture PENDING; refund PENDING and getRefund; payer-action extraction; raw-embedding verify body; token caching; request ids; unique invoice_id; payee merchant_id match and mismatch; refund `custom_id` | `npm run check:paypal` once the user creates sandbox credentials: prints merchant id → create → approve URL → `--capture` → refund |
| Morning | Token; 400/320/330; vatType; payment types; marker search; UNKNOWN protocol | `npm run check:morning` once sandbox credentials exist |
| DHL | Builders `satisfies` the generated request types; snapshot (9701910000, DAP, export declaration); response parsing from synthetic fixtures; tracking map; claim protocol | `npm run check:dhl`: api-mock first, then the test environment only with the painter's account |

---

## 5. Core flows

### 5.1 Checkout and reservation
1. **Artwork page.** "Buy now" shows when all of these hold:
   - AVAILABLE with no live foreign hold;
   - priced, and neither `price_on_request` nor `quote_only`;
   - not a demo item while a live provider is configured.

   It links to `/[locale]/checkout/[slug]`. No hold is created yet.
2. **Checkout page** `/[locale]/checkout/[slug]?to=<CC>&ship=<METHOD>&cur=<ILS|USD>`. It is dynamic and noindex, calls `getCheckoutQuote(...)`, and renders:
   - **Blocked states** with CTAs ("Request a quote" / "Ask about this work").
   - **Delivery:**
     - a country `<select>` (`Intl.DisplayNames`, `Intl.Collator`) in a GET form with a no-JS button;
     - method radios with price, estimate, and "tracked" plus "insured up to ₪X" only when the quote includes insurance;
     - a currency toggle when USD is possible;
     - notices.
   - **Details form** (`useActionState`): name, email, phone, address (Latin abroad), optional company name and VAT ID.
   - **`PreContractDisclosure`**, built from `content/disclosure.ts` `buildPreContract()`:
     - seller legal name, ID/company number, address, phones (local and +972), email, **"Merchant country: Israel"**, customer service;
     - main characteristics;
     - the total (VAT wording per mode);
     - delivery method and estimate;
     - payment terms including installments;
     - cancellation rights (14 days; 4 months when eligible and a conversation took place);
     - fee and channels; DAP notice; links; s.11 notice.
   - **Checkboxes**, all unticked: terms + returns (required), 18+ (required), DAP (international, required), receipt by email (optional).
   - **Provider radios**, with labels built from capabilities. For example, "Card – Cardcom secure page" adds "Bit / Apple Pay / Google Pay" only when `CARDCOM_WALLETS` lists them, and Bit only for ILS ≤ ₪5,000.
   - Hidden fields: `expectedTotalMinor`, `checkoutNonce`, `locale`, and a signed form timestamp.
   - "When you continue, the work is reserved for you for 35 minutes."
3. **`startCheckoutAction(formData)`**
   1. Honeypot, form age ≥ `FORM_MIN_AGE_MS`, rate limits, zod validation with locale-aware messages.
   2. **Double submit:** `client_request_id` exists → resume that order. A 23505 during insert also resumes.
   3. **Server re-quote:** a different total → `{ error: 'price_changed', quote }`, and nothing is written.
   4. **Guards:** demo with a live provider; go-live blockers (CRITICAL alert); currency support.
   5. **Conversation detection** (`checkout/conversation.ts`): if a `buyer_requests` row exists with the same lowercased email within `conversationLookbackDays`, set `conversation_took_place=true` and `conversation_source='REQUEST:<id>'`. This is the conservative, buyer-favourable default.
   6. **Transaction** per §3.5: lock artworks → advisory locks and caps → insert the order (`quote_version 1`, `first_held_at`, `hold_count 1`, snapshots, consents, VAT, `shipping_quote`, ip hash, fx) → items → reserve UPDATE (count n, else `just_reserved`) → takeover expiry → attempt #1 (CREATED, `quote_version`, amount, `create_request_id`, mode, `merchant_ref`, `is_demo`) → audit.
   7. **Outside the transaction:** `createCheckout` (15 s). Error → attempt FAILED with the hold kept. Success → PENDING with `provider_ref` and `redirect_url` stored, **then** redirect.
   8. `redirect(next.url)`. CSP `form-action` allows the provider origins.
4. **Order page** `/[locale]/orders/[number]?k=<token>` (noindex, `no-referrer`).
   - **AWAITING_PAYMENT:**
     - countdown; attempt status (5 s meta refresh for up to 2 min);
     - `payOrderAction`: a new attempt with the current `quote_version`; re-reserves if the hold expired and the works are free, subject to the §3.5 hold budget;
     - `releaseReservationAction`.
     - **Both are refused while any attempt on the order is CAPTURING or PAYMENT_REVIEW**, which shows "payment being confirmed".
   - **Link orders with incomplete details** show the form. Changing the shipping method or address calls `requoteOrder(tx, orderId, newQuote)`:
     - locks artworks → order;
     - refuses while an attempt is in flight;
     - updates the amounts and bumps `quote_version`.

     Older PENDING attempts stay open at the provider, but can no longer pay the order (§5.2 step 5).
   - **Other states:** PAYMENT_REVIEW; PAID/COMPLETED (timeline, tracking with DHL attribution, documents via signed URLs, a prefilled cancel link); EXPIRED; CANCELLED.

### 5.2 Payment finalization (`payments/finalize.ts`, `capture.ts`, `apply.ts`)
```ts
finalizeAttempt(attemptId: string, source: 'webhook'|'return'|'reconcile'|'admin'):
  Promise<{ outcome: 'paid'|'already_final'|'pending'|'deferred'|'review'|'failed'|'needs_refund'|'lost_before_capture'|'config_drift'|'unknown'; orderId: string; effects: Effects }>
```

**Webhook route** `POST /api/payments/[provider]/webhook`
1. `await connection()`; `raw = await request.text()`.
2. **Authenticate first:**
   - mock HMAC and the Cardcom token are cheap and touch no DB;
   - PayPal: a per-IP limit of 60/min, then the verify postback.

   A failure records a per-IP failure count (`webhook-fail:<ip>`, 30/min, 429 after that) and returns 401. An authenticated request is never answered with 429.
3. `INSERT payment_events … ON CONFLICT (provider, event_key) DO UPDATE SET received_count = payment_events.received_count + 1 RETURNING processed_at`. If `processed_at` is set, return 200 (a true duplicate).
4. Resolve the attempt (Cardcom `a`; PayPal `custom_id` or `(PAYPAL, order_id)`; mock ref). Refund, reversal and dispute events go to `syncPostSuccessEvent`; everything else to `finalizeAttempt`.
5. Success (any outcome except `unknown`) → set `processed_at` and `outcome` → 200.
6. **An exception, or an `unknown` outcome** → record `last_error`, set the attempt's `next_check_at=now()`, and **return 500** so the provider retries.
7. A DB failure at step 3 → 500.

Reconcile also replays unprocessed events (§5.11).

**Return route** `GET /api/payments/[provider]/return?a&r&l&s`
- 60/min/IP. A bad `r` → 303 to `/[l]/checkout/returned`.
- `s=cancel` → 303 to the order page with `&payment=canceled`.
- Otherwise finalize within an 8 s budget, then 303 with `&payment=<outcome>`. The `s` hint is never trusted.

**Algorithm**
1. **Load** without locks. SUCCEEDED, NEEDS_REFUND or REFUNDED → `already_final`.
2. **Provider:** `providerForAttempt`; on drift → `config_drift`.
3. **Fetch:** `vp = fetchPayment()` with no locks held. On error: update `check_count` / `next_check_at` and return `unknown`.
4. **Verify:** `echoedReference===attemptId`, `merchantRef===attempt.merchant_ref` (PayPal: the payee `merchant_id`), and the money moved equals `attempt.amount_minor` and currency exactly.
   - Mismatch with money taken → NEEDS_REFUND (AMOUNT_MISMATCH): a **MANUAL_REQUIRED refund row** with `legal_due_at = now()+14 days`, a CRITICAL alert, the order is never paid, and there is no automatic provider call.
   - Mismatch with no money taken → FAILED plus an alert.
5. **Quote binding:** if `attempt.quote_version ≠ order.quote_version`, or the amount or currency differs from the order's total → the stale-quote path. A success becomes NEEDS_REFUND (STALE_QUOTE) with an automatic refund. A capture claim becomes CANCELED with nothing captured.
6. **Branch on `vp.state`:**
   - **`pending`:** no change. Past the watch window (Cardcom 72 h, PayPal 72 h, mock 1 h) the attempt becomes EXPIRED. Cardcom attempts keep `tail_until = created + 30 days` for daily polling.
   - **`failed | canceled | expired`:** conditional update. The hold stays until its TTL.
   - **`refunded`** (refunded at the provider before we finalized): an EXTERNAL SUCCEEDED refund row, the attempt → REFUNDED, the order unchanged, a WARNING alert.
   - **`partially_refunded`:** an EXTERNAL refund row for `refundedMinor`, then continue as `succeeded`, plus a CRITICAL alert for the painter to decide.
   - **`requires_capture`** (`capture.ts`):
     1. **Claim transaction:** lock artworks → order → attempt.
        - The order must be AWAITING_PAYMENT or EXPIRED. If another attempt has paid it → CANCELED, never captured.
        - The quote is bound and every work is sellable for this order → re-reserve with `reserved_until = greatest(coalesce(reserved_until, now()), now()+10 min)`, mirror it, and EXPIRED → AWAITING_PAYMENT.
        - `UPDATE payment_attempts SET status='CAPTURING', capture_request_id=coalesce(capture_request_id, gen_random_uuid()), capturing_since=coalesce(capturing_since, now()), capture_tries=capture_tries+1, last_checked_at=now() WHERE id=$a AND (status IN ('PENDING','AWAITING_CAPTURE','EXPIRED') OR (status='CAPTURING' AND ($source IN ('reconcile','admin') OR last_checked_at < now()-interval '60 seconds')))`.
        - Zero rows (another worker is capturing right now) → `pending`.
        - Not sellable, or a 23505 on the winner index → CANCELED, nothing captured, the `purchase-not-completed` email ("you were not charged"), `lost_before_capture`.
     2. **Outside the transaction:** `capture(ref, capture_request_id)`. A network error leaves it CAPTURING with `next_check_at=now()+2 min`. Reconcile re-runs the whole algorithm: GET first, so a capture that did happen shows as `succeeded`; otherwise the re-entrant claim, re-check, re-extend and capture with the same key.
     3. **Capture watch:** after 6 tries or 24 h in CAPTURING with GET still APPROVED → CANCELED, hold released, CRITICAL alert.
   - **`review`:** attempt and order → PAYMENT_REVIEW; hold `now()+7 days`; `fulfillment_blocked_reason='PAYMENT_REVIEW'`; `payment-review` email; alert after 24 h. When resolved: COMPLETED → `succeeded`. DENIED → attempt FAILED, order AWAITING_PAYMENT (or EXPIRED), **hold shortened to `now()+reservationMinutes`**.
   - **`succeeded` → `applySuccessfulPayment(attemptId, vp)`**, one short transaction:
     1. Read the immutable `order_items`. Lock artworks `ORDER BY id`, then the order, then the attempt.
     2. Attempt final → `already_final`.
     3. **Another attempt on this order is CAPTURING or PAYMENT_REVIEW → `deferred`:** no state change, `next_check_at = now()+15 min`, WARNING alert. Reconcile re-evaluates once the other attempt resolves: this one then applies, or becomes DUPLICATE_PAYMENT.
     4. Quote not bound → NEEDS_REFUND (STALE_QUOTE).
     5. Order PAID/COMPLETED by another attempt → NEEDS_REFUND (DUPLICATE_PAYMENT). Order CANCELLED → NEEDS_REFUND (ORDER_CANCELLED).
     6. Any work not sellable → NEEDS_REFUND (LOST_RESERVATION); the order → CANCELLED (LOST_RESERVATION).
     7. Otherwise apply, in order:
        - artworks → SOLD (sellable predicate in `WHERE`, count n), hold cleared;
        - expire other orders whose expired holds were taken over;
        - `INSERT sales` (ONLINE, `is_mock = provider_mode='MOCK'`);
        - attempt → SUCCEEDED with the payment details;
        - order → PAID (from AWAITING_PAYMENT, EXPIRED or PAYMENT_REVIEW);
        - `INSERT shipments(… export_decl_status …) ON CONFLICT (order_id) DO NOTHING`;
        - enqueue `email:order-confirmation`, `email:painter-new-order`, `taxdoc:receipt:<attemptId>`;
        - audit; an INFO alert if the payment was late.
     8. Commit and return effects.
     9. A 23505 on the sales or winner index is caught outside the aborted transaction and goes to the NEEDS_REFUND transaction.
   - **NEEDS_REFUND transaction:**
     - attempt → NEEDS_REFUND;
     - insert `refunds` (REQUESTED; amount = the received amount; reason; `idem_key`; `legal_due_at = now()+14 days`) and a `REFUND_PAYMENT` job (AMOUNT_MISMATCH: MANUAL_REQUIRED, no job);
     - the receipt job (per `receiptForRefundedPayments`, never for AMOUNT_MISMATCH);
     - the `purchase-not-completed` email;
     - a CRITICAL alert.

**`syncPostSuccessEvent`** (`payments/post-success.ts`; PayPal REFUNDED / REVERSED / dispute)
- Lock order → attempt.
- **Match first:**
  - by `refunds.id = resource.custom_id`;
  - otherwise by `provider_refund_id`;
  - otherwise one of our IN_FLIGHT / UNKNOWN / PROVIDER_PENDING rows for the same capture and amount.

  Attach `provider_refund_id` and mark it SUCCEEDED (which enqueues REFUND_SETTLED).
- Only an unmatched refund is inserted as EXTERNAL SUCCEEDED.
- REVERSED → CRITICAL alert. A dispute → alert. Both set `fulfillment_blocked_reason` when the order is unshipped.
- Errors propagate, so the webhook returns 500.

### 5.3 Failure modes covered
| # | Failure | Detection | Automatic response | Residue |
|---|---|---|---|---|
| 1 | Two buyers pay at once | locks before inserts + conditional reserve | one hold, no deadlock; the other sees "just reserved" | – |
| 2 | Abandoned page | hold TTL | EXPIRED, available | – |
| 3 | Webhook lost (always on localhost) | return route, reconcile, recheck | finalize via re-query | – |
| 4 | Duplicate webhook | `processed_at` | no-op | – |
| 5 | First processing of a webhook fails | `processed_at` null | 500 → provider retry; reconcile replays | – |
| 6 | Forged webhooks | token / HMAC / verify postback, before any DB write | 401; per-IP failure limit | – |
| 7 | Webhook flood | auth first; per-IP buckets | real webhooks unaffected | WAF later |
| 8 | Late success, work free | sellable predicate (without the publish requirement) | EXPIRED → PAID | – |
| 9 | Late success, work gone | predicate + sales index | NEEDS_REFUND, automatic refund, receipt + credit note, email, CRITICAL | without ApiPassword → MANUAL_REQUIRED with deadline |
| 10 | Cardcom payment after 72 h, webhook lost | daily tail poll for 30 days; live ListTransactions sweep | as #8 or #9; unmatched transaction → CRITICAL | – |
| 11 | Paid twice | winner index / already PAID / deferral during capture | DUPLICATE_PAYMENT refund | – |
| 12 | Stale attempt paid after the quote changed | `quote_version` binding | STALE_QUOTE automatic refund; never PAID at the wrong total | – |
| 13 | Amount, merchant or reference mismatch | verify step | never paid; MANUAL_REQUIRED refund with deadline; CRITICAL | investigate |
| 14 | Timeout on create | ProviderTimeoutError | FAILED; hold kept | buyer retries |
| 15 | Timeout on capture | CAPTURING with re-entrant claim; in-flight hold not takeable | reconcile: GET → re-check → capture with the same key; watch → CANCELED | – |
| 16 | PayPal capture PENDING | review | PAYMENT_REVIEW; new attempts refused; DENIED shortens the hold | – |
| 17 | Reversal or dispute | webhook (500 on failure) | block fulfillment; CRITICAL | painter responds in PayPal |
| 18 | Refund crash or timeout | IN_FLIGHT lease / timeout | UNKNOWN; never re-called blindly; PayPal same request id within 6 h; Cardcom FAILED counts in the cap until confirmed | admin confirms |
| 19 | Own PayPal refund webhook arrives before our record | `custom_id` / in-flight matching | attached, not double-counted | – |
| 20 | Over-refund | lock + cap that counts unconfirmed FAILED rows | rejected | – |
| 21 | Morning timeout | UNKNOWN | marker search | NEEDS_MANUAL |
| 22 | DHL label timeout | – | LABEL_UNKNOWN | check MyDHL |
| 23 | Worker crash | lease expiry | reclaimed; handlers idempotent | DEAD → retry |
| 24 | Email outage | outbox | order unaffected; printed disclosure gate | – |
| 25 | Cron skipped | idempotent; `cron_runs` | lazy expiry; warning after 15 min | – |
| 26 | Price change during checkout | `expectedTotalMinor` | `price_changed` | – |
| 27 | Admin hides or holds a work during checkout | guards | override + later refund; refused while in flight | – |
| 28 | Config drift | `provider_mode` / `merchant_ref` | refuse; CRITICAL | admin |
| 29 | Demo work charged live, or a real work bought via mock in production | registry + CHECK | impossible | – |
| 30 | Hoarding | caps under advisory locks; per-artwork budget; cooldown; hold span | 429 / refusal | – |
| 31 | Disclosure not delivered | checklist + collection and delivery guards | blocked until confirmed | – |
| 32 | Refund settled but the order transition fails | REFUND_SETTLED job | retried; the refund row is already final | DEAD → alert |
| 33 | Second cancellation notice | no unique index | stored, flagged as a possible duplicate, acknowledged | admin links |

### 5.4 Outbox, documents and emails
- **Enqueue:** `enqueue(tx, …)` with `ON CONFLICT (dedupe_key) DO NOTHING`.
- **Process:** `processOutbox({ limit })` claims jobs with:
  ```sql
  UPDATE outbox_jobs SET status='RUNNING', locked_until=now()+interval '5 min', attempts=attempts+1
  WHERE id IN (SELECT id FROM outbox_jobs
               WHERE (status='PENDING' AND run_after<=now()) OR (status='RUNNING' AND locked_until<now())
               ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
  RETURNING *
  ```
  It then marks DONE, backs off, or marks DEAD after 8 attempts.
- **Triggers:** `after()`, cron every 5 min, and `npm run cron -- outbox` (via HTTP).
- **Handlers** (each idempotent):

  | Handler | Behaviour |
  |---|---|
  | `SEND_EMAIL` | Skip if already SENT. Render fresh data in `orders.locale`. `order-confirmation` gets the inline disclosure summary and link; the PDF attachment is Tier B (`ensureDisclosurePdf`; on a render failure, send without it plus a WARNING). Sets `disclosure_sent_at` and `disclosure_version`. |
  | `ISSUE_TAX_DOCUMENT` | §4.3 |
  | `ISSUE_CREDIT_NOTE` | Reschedules while the receipt is non-final. |
  | `REFUND_PAYMENT` | `executeRefund` |
  | `REFUND_SETTLED` | In order → attempt → refund lock order: NEEDS_REFUND attempt → REFUNDED; a cancellation refund → order CANCELLED (from PAID or COMPLETED); credit-note job; `refund-issued` email; audit. |

- **Disclosure (s.14C(b))**
  - Source: one builder, `content/disclosure.ts` (signature frozen in M1, implemented by WS6), in he or en.
  - Contents: seller identity including the ID number; the work; total price with VAT and delivery; delivery date and method; payment terms; cancellation rights (14 days or 4 months; channels; fee; return); copyright and moral rights.
  - Renderers: the HTML page `/[locale]/print/disclosure/[number]?k=`, the inline email summary, and the react-pdf PDF (Tier B). **The printed copy goes in the parcel or is handed over at pickup.**
- **Printables** (`@page A4`):
  - admin under `/print/admin/*`: packing slip, commercial invoice (English; full §4.4 content, signature line), COA (Tier B; bilingual; QR via qrcode 1.5.4; copyright s.37(c), moral rights s.45(b)), s.4C studio notice;
  - buyer: disclosure and mock receipt (`?k=`).

### 5.5 Fulfillment (`shipping/shipments.ts`, `/[locale]/admin/orders/[id]/fulfill`)
**Guards**
- Order PAID, with no `fulfillment_blocked_reason` and no ACCEPTED cancellation.
- **A RECEIVED cancellation blocks fulfillment unless overridden.** The override needs a reason, is audited, and shows "a cancellation notice is pending; shipping now may still require a refund".

**Steps**
1. **Pack.** The checklist depends on the packaging type:
   - nothing touches the paint surface (corner protectors, rigid spacer, silicone release paper only if contact is unavoidable, never glassine or tissue on the paint, especially acrylics);
   - roll only if `can_be_rolled`, in a tube ≥ 10 in;
   - plywood crates are ISPM-15 exempt; never ship uncured work;
   - COA signed; **disclosure printed and inserted (required)**; receipt printed if there was no email consent;
   - packing photos via `<input type=file accept="image/jpeg,image/png,image/webp" capture="environment" multiple>`, each uploaded through `POST /api/admin/uploads?purpose=packing`. At least one is required for international or insured shipments.

   Confirm the packed dimensions and weight → **PACKED**.
2. **Customs** (international): HS code, description, declared and insured value; export declaration REQUIRED → RECORDED or PENDING_CARRIER; generate the commercial invoice.
3. **Ship**, one of:
   - **(a) Manual tracking** → LABEL_CREATED; "handed over" → IN_TRANSIT.
   - **(b) Buy label:** claim PACKED → LABEL_REQUESTED (`label_attempt+1`, `idempotency_key=<orderId>:<n>`, a new `message_reference`); commit; `createShipment`. Success → LABEL_CREATED, files private. Definitive error → PACKED. Timeout → LABEL_UNKNOWN plus an alert.
   - **(c) Pickup:** READY_FOR_PICKUP (the email reveals the address) → COLLECTED. This requires `disclosure_sent_at` or the "printed disclosure handed over" checkbox (`disclosure_handed_over_at`).
   - **(d) Artist delivery:** OUT_FOR_DELIVERY → DELIVERED, with the same disclosure guard.
4. **Every status change:**
   - inserts a `shipment_events` row;
   - enqueues `email:shipment-update:<id>:<status>`;
   - on DELIVERED or COLLECTED, sets `orders.delivered_at`, `cancellation_window_ends_at` and `insurance_claim_deadline_at` (+30 days).

### 5.6 Tracking (`jobs/tracking.ts`, hourly)
- **Selection:** MOCK or DHL shipments in LABEL_CREATED … OUT_FOR_DELIVERY or EXCEPTION whose `last_tracked_at` is older than 1 h.
- **Processing:** `track()` → insert events (ON CONFLICT DO NOTHING) → advance monotonically → one email per new status.
- **DHL data:** shown with "Delivered by Deutsche Post DHL Group"; raw data purged 30 days after delivery.
- **Manual carriers:** the admin adds events by hand.

### 5.7 Cancellation, return and refund
1. **Link.** "ביטול עסקה / Cancel a purchase" sits in the header and footer of every public page, in the checkout footer, in every buyer email and in documents.
2. **`/[locale]/cancel`** explains the rights and lists every channel: phone (local and +972), email, registered mail, and the online form.
3. **Step 1: a single form, submitted by POST** (a Server Action; nothing goes in the query string).
   - **Required:** full name, plus either the ID/passport number **or** the order number. The form says: "for Israeli consumers, name and ID number are enough".
   - **Optional:** email (needed only for the emailed acknowledgement), phone, reason, message, "where was the order shipped" (sets the regime when no order is matched), and the eligibility declaration.
   - Also: honeypot, 20/h/IP, an s.11 notice.
   - The final wording is for the lawyer.
4. **Step 2: review.** The server renders an HMAC-signed payload in a hidden field (works without JS). **"Confirm cancellation"** → `confirmCancellation`:
   - **always inserts** a RECEIVED row (`received_at`, `refund_due_at` = +14 days);
   - matching runs afterwards and never blocks the insert;
   - shows the on-screen acknowledgement (content with the ID masked, date and time in Asia/Jerusalem, `C-XXXXXX`, printable);
   - enqueues `cancellation-ack` (when an email was given) and `painter-cancellation`.
5. **Matching:**
   - Auto-match on order number plus (email or name).
   - If an open cancellation exists for that order, the new row gets `possible_duplicate=true` and `duplicate_of_id`, but is still stored and acknowledged.
   - Matching sets `fulfillment_blocked_reason='PENDING_CANCELLATION'` while it is RECEIVED, and re-runs conversation detection.
   - The admin logs PHONE, EMAIL, REGISTERED_MAIL and IN_PERSON notices at `/admin/cancellations/new` with the actual receipt time.
6. **Deadlines** (`src/lib/deadlines.ts`, pure):
   - `windowStart = max(deliveredAt, disclosureSentAt ?? deliveredAt)`; a cancellation before delivery is valid.
   - `windowEnd = windowStart + (eligible_group≠NONE && conversation_took_place ? 4 months : 14 days)`.
   - The admin review shows the conversation source, and **defaults to granting the 4-month window when eligibility is declared and the conversation is uncertain**.
   - Fee: IL regime and CHANGE_OF_MIND → `min(round(5% × total paid), ₪100)`, with the locked FX for USD; otherwise 0.
7. **Admin decision:**
   - shows the window, fee, refund amount and **"Refund due by <date>"** (from the notice);
   - warns when the work is not back yet (whether a refund may wait for the return is a lawyer question);
   - **Accept:** if not shipped → shipment CANCELLED and the refund now; if shipped → AWAITING_RETURN plus the `return-instructions` email;
   - **Reject:** reason from a template.
   - Works on PAID **and COMPLETED** orders.
8. **`requestRefund` / `executeRefund`** (`payments/refunds.ts`; fresh admin session for manual refunds):
   1. **Transaction** (lock order → attempt → refund): check `captured − Σ(all rows except FAILED with failure_confirmed_at) ≥ amount`. Insert REQUESTED with an `idem_key`. Enqueue `refund:<id>`.
   2. **`executeRefund`:**
      - claim REQUESTED → IN_FLIGHT (`provider_calls+1`, `in_flight_until=now()+2 min`) and commit;
      - **if the row is IN_FLIGHT with an expired lease, or UNKNOWN → never call; set UNKNOWN; reconcile resolves it.**
   3. Call `provider.refund` outside the transaction.
   4. **Result transaction** (the refund row only):

      | Result | Next |
      |---|---|
      | succeeded | SUCCEEDED, and enqueue `refund-settled:<id>` |
      | pending | PROVIDER_PENDING |
      | not configured | MANUAL_REQUIRED + alert + dashboard instructions; "Mark refunded" needs a reference → MANUAL_DONE |
      | timeout | UNKNOWN |
      | rejected | FAILED + alert (still counted in the cap until confirmed) |

   5. **UNKNOWN resolution (reconcile):**
      - PayPal: `getRefund`, or a re-post with the same request id within 6 h;
      - Cardcom: ListTransactions when an ApiPassword exists, otherwise the admin confirms.
   6. The `REFUND_SETTLED` job performs the order and cancellation transitions (§5.4).
9. **Close:** return received → inspection → CLOSED once the refund has settled → **Relist** (sale voided) or **Mark damaged**.
10. **Alerts** (daily): due in ≤ 5 days (WARNING), ≤ 2 days (CRITICAL), overdue (CRITICAL daily). The dashboard shows a red card.

### 5.8 Quotes, offers and link orders
- **Forms:** `/[locale]/works/[slug]/request?kind=question|quote|offer` and `/[locale]/contact`. Each has an s.11 notice, a honeypot, 5/h/IP, and the `request-ack` and `painter-new-request` emails.
  - **Quote** (Tier A): for quote-only works and for SIZE_QUOTE / VALUE_CAP / GB_LOW_VALUE / ZONE_DISABLED results.
  - **Offer** (Tier B): AVAILABLE works; amount; currency (ILS, or USD for non-IL); at most one pending offer per email per artwork; auto-decline threshold.
- **Admin inbox:** reply; decline; send quote (Tier A); accept or counter (Tier B).
- **`createLinkOrder({ kind, artworkId, buyer, country, currency, itemPriceMinor, lockedShippingMinor?, shippingMethod?, conversationTookPlace, expiresInHours = 48, locale }, ctx)`**
  - One transaction: lock the artwork (reservable; the admin may bypass `quote_only` and `price_on_request`); advisory locks; insert the order (`quote_version 1`, `conversation_took_place` default true for MANUAL and OFFER, plus detection) and items; reserve.
  - Enqueue `checkout-link`. The request moves to QUOTED / ACCEPTED / COUNTERED with its `order_id`.
  - Payment uses `startPaymentForOrder`, which extends the hold to `greatest(reserved_until, now()+35 min)`.
  - PAID → CONVERTED. Expiry → EXPIRED.
  - Country and currency are fixed. IL ⇒ ILS.

### 5.9 Admin offline hold, sale and relist
- **Actions:** `setOfflineHold`, `releaseOfflineHold`, `markSoldOffline(id, { date, priceMinor?, currency?, note })`, `relist`, `markNotForSale`. Each locks artworks first and uses conditional updates.
- **Offline sale** inserts `sales` OFFLINE. It counts toward the turnover widget (mock and demo sales are excluded).
- **During a live checkout hold:** a dialog ("A buyer is checking out until 14:32 …"). Confirming expires that order (ADMIN), clears the hold and applies the action. **Refused while an attempt is CAPTURING or PAYMENT_REVIEW.**
- **Relist rules:** an online sale needs the order CANCELLED, the refund settled, and the return INSPECTED_OK or NOT_APPLICABLE. An offline sale needs confirmation. Always audited; voids the sale.

### 5.10 Manual distance order
- `/admin/orders/new` sets artwork, buyer, country, price (edits need a reason), currency, shipping (table or manual), language, `conversation_took_place` (default **true**) and expiry, then calls `createLinkOrder(kind:'MANUAL')`.
- Payment is either the emailed link (same disclosures and deadlines) or **"Record payment received"**, which requires the exact amount (§4.2). That leads to PAID, the right tax-document payment type, and the disclosure email.
- In-person sales use the s.4C notice at `/print/admin/studio-notice`.

### 5.11 Cron jobs (`/api/cron/[job]`)
- **Route:** GET with `Authorization: Bearer CRON_SECRET` (timing-safe) and `await connection()`.
- **Every job:** idempotent; a **60 s wall-clock budget**; concurrency ≤ 3 for provider calls; items ordered by `next_check_at`; a clean stop when the budget runs out; a `cron_runs` row.
- **Locally:** `npm run cron -- <job>` or `-- --watch` (an HTTP client).

| Job | Schedule (UTC) | Work |
|---|---|---|
| `reconcile` | `*/5 * * * *` | (1) Replay `payment_events` with `processed_at IS NULL` older than 2 min and younger than 3 days (≤ 20). (2) Attempts in PENDING, AWAITING_CAPTURE, CAPTURING or PAYMENT_REVIEW, and PENDING attempts left `deferred`, with `next_check_at ≤ now()` → finalize. Backoff 2m, 5m, 15m, 30m, 1h, 2h, then every 4h until the watch window. CAPTURING attempts re-extend their hold on each pass. (3) Refunds in PROVIDER_PENDING or UNKNOWN → `getRefund`. IN_FLIGHT rows with an expired lease → UNKNOWN. (4) AWAITING_PAYMENT orders with `expires_at < now()` and no in-flight attempt → EXPIRED, holds released (artworks first); link requests → EXPIRED. |
| `outbox` | `*/5 * * * *` | `processOutbox({ limit: 50 })` within the budget |
| `tracking` | `0 * * * *` | §5.6 |
| `daily` | `0 5 * * *` | **Cardcom tail:** EXPIRED Cardcom attempts with `tail_until > now()` → GetLpResult. **Live sweep** (ApiPassword present): ListTransactions for the last 3 days; match by transaction id or ReturnValue to attempts; unknown → CRITICAL "unmatched Cardcom transaction"; matched but not applied → finalize. Deadline alerts (refunds, unshipped beyond `dispatch_days+2`, export declaration > 7 days, review > 24 h, tax docs needing action, DEAD jobs, turnover ≥ 80% / 95% of the ceiling excluding mock and demo, rates uncalibrated or > 90 days, failed sign-ins > 10/day). COMPLETED transitions (§3.6). `checkInvariants()` (Tier B). Go-live digest. |
| `purge` | `30 2 * * *` | Retention (§7) |

---

## 6. Public site and admin

### 6.1 Visual identity: a "white cube" gallery
- **Tokens:** `--color-paper` #fbfaf7, `--color-wall` #f3f1ec, `--color-ink` #1d1c1a, `--color-ink-muted` #5e5a53, `--color-line` #e2ded6, `--color-reddot` #b4231a, `--color-hold` #7a5f14. Radius 2 px.
- Paintings are never cropped and never placed on colour.
- **Fonts:** `next/font/google` with subsets `["hebrew","latin"]` and `display:"swap"`: **Frank Ruhl Libre** for headings, **Assistant** for body, mapped via `@theme inline`.
- Body 17 px; line height 1.7 in he and 1.6 in en.
- **No italics, uppercase or small caps in Hebrew** (`ltr:uppercase` only).
- Motion: an image fade only, disabled under reduced motion. Directional icons carry `rtl:-scale-x-100`.
- Copy: gender-neutral public Hebrew; admin buttons use action nouns ("שמירה", "פרסום", "סימון כנמכרה").

### 6.2 Public routes (`/[locale]`, defaultLocale `he`, `localePrefix "always"`; `/` redirects by Accept-Language)
| Route | Content |
|---|---|
| `/` | Hero with a featured available work as LCP (`fetchPriority="high"`, `loading="eager"`). Available works, series, about snippet, commissions CTA. Organization JSON-LD (`hasMerchantReturnPolicy`, `hasShippingService`). |
| `/works` | GET filters: availability, series, size bucket, orientation, price bands. Sorts: featured, newest, price, size. 24 per page. Default view is available + on hold, plus a "Recently sold" strip (≤ 4). `?availability=sold` is the archive. |
| `/works/[slug]` | §6.3 |
| `/works/[slug]/request` | §5.8 |
| `/about`, `/contact`, `/credits` | Person JSON-LD; `dir=ltr` phones and emails; AIC captions ("Artist. Title, Date. The Art Institute of Chicago."), CC0 note, font licences. |
| `/legal/[doc]` | terms \| returns \| shipping \| privacy \| accessibility. TSX drafts filled from the business profile **without `idNumber`**. DRAFT banner until approved. No "all sales final"; restrictions use the s.2(b2) qualifier. |
| `/cancel` | §5.7 (noindex) |
| `/orders/[number]?k=` | §5.1 (noindex) |
| `(checkout)/*`, `(print)/*` | noindex; `mock-pay` returns 404 unless mock is enabled for that attempt |

### 6.3 Key components
- **`JustifiedGrid`:** pure CSS; each item `flex: <aspect> 1 calc(<aspect> * var(--row-h))` with `next/image` (`sizes="(min-width:1280px) 30vw, (min-width:768px) 45vw, 100vw"`, blur placeholder); visible captions; a trailing spacer; one column below 640 px.
- **Artwork page:**
  - breadcrumbs;
  - a scroll-snap strip on mobile with a counter, and a main image plus thumbnails on desktop;
  - **`ArtworkLightbox`**: yet-another-react-lightbox 3.32.2 with Zoom and Counter, lazy-loaded; `controller={{ aria: true }}`; Hebrew labels; live region "תמונה 2 מתוך 5"; focus returns to the trigger; slides via `getImageProps()` at q90;
  - **`ArtworkFacts`**: medium on surface, H × W × D in cm and inches in `<bdi dir="ltr">`, framed, ready to hang, signed, COA, packaging, dispatch days;
  - **`LiveBuyBox`** (uncached):
    - ₪ price or the status in text;
    - Buy / Ask / (Tier B) Offer;
    - "Delivery in Israel from ₪X · free studio pickup" linking to the shipping page; zone estimates;
    - DAP note;
    - trust row "tracked · 14-day cancellation · COA", plus "insured" only when the cheapest IL quote includes insurance;
    - JSON-LD `["VisualArtwork","Product"]` with an Offer (ILS = the visible price; none for NFS, price-on-request, or demo while live);
  - `<details>` accordions;
  - **`StickyBuyBar`** on mobile (safe-area inset);
  - sold works offer "Ask about similar works" and "Request a commission";
  - AIC credit under demo images.
- **`components/ui`** (M1): Button, Field, Input, Select, Checkbox, RadioGroup, Textarea, ErrorSummary, Badge (always text), Price, Dimensions, Bdi, Dialog (native), Accordion, Countdown, SubmitButton, ConfirmButton, PrivacyNotice, CancelPurchaseLink, SkipLink, VisuallyHidden.

### 6.4 i18n and RTL
- **next-intl 4.14.8:**
  - `routing.ts` `defineRouting({ locales:['he','en'], defaultLocale:'he', localePrefix:'always' })`;
  - `request.ts` uses the explicit locale, else `next/root-params`; `hasLocale` / `notFound`; `timeZone 'Asia/Jerusalem'`; messages from `namespaces.ts`;
  - `navigation.ts` `createNavigation(routing)`.
- **`src/proxy.ts`:** paths matching `/(he|en)/(admin(?!/login)|print/admin)` without `getSessionCookie` → redirect to login (optimistic only); otherwise next-intl. Matcher `'/((?!api|_next|_vercel|.*\\..*).*)'`.
- **Root layout:** `<html lang dir>`. `experimental.globalNotFound` with `global-not-found.tsx`, plus `[locale]/not-found.tsx`.
- **CSS:** Tailwind 4.3.3, logical utilities only (`ms-/me-/ps-/pe-`, `inset-s-/inset-e-`, `text-start/end`, `border-s/e`, `rounded-s/e`, `mbs/mbe`), plus `rtl:`/`ltr:`.
  - Never mirror artworks, logos, media controls, prices, dimensions or phones.
  - `<bdi>` for prices, dimensions, emails, phones, URLs and order numbers.
  - Inputs use `dir="auto"`; email, phone and ID inputs use `dir="ltr"`.
- **Formatting:** server Intl (`he-IL` / `en-IL`, Asia/Jerusalem); whole amounts without decimals; he plurals one/two/other; tests normalise U+200F and U+00A0.
- **Language switch** keeps the path and query. hreflang via next-intl plus `alternates.languages {he, en, x-default}`.

### 6.5 Pricing display
- One ILS total price per catalog URL (VAT-inclusive when murshe, binding), matching the JSON-LD.
- `/en` explains that buyers shipping abroad can pay in USD at checkout.
- USD appears only after a non-IL destination is chosen, and only if a USD price exists.
- "Delivery from ₪X" links to every option.
- Price changes need confirmation and are audited.
- Lawyer question: foreign-currency display (s.17G(a)(1)).

### 6.6 SEO
- `generateMetadata` (metadataBase, per-locale canonical, alternates, OG from `og_key`); descriptive file names.
- JSON-LD:
  - artwork: VisualArtwork + Product with creator, dateCreated, artform, artMedium, artworkSurface, `QuantitativeValue` in CMT, sku, NewCondition, Offer;
  - BreadcrumbList, Organization, Person.
- `sitemap.ts`: dynamic, with alternates and images.
- `robots.ts`: allow all except `/api/`. Private pages use `noindex` metadata. Demo mode uses the `X-Robots-Tag` header.

### 6.7 Accessibility (WCAG 2.2 AA target; no overlays)
- Skip link "דילוג לתוכן"; landmarks; one h1 per page; visible focus; targets ≥ 24 px (44 preferred); status always as text.
- Forms: visible labels plus "(חובה)"; `autocomplete` and `inputmode`; error summary plus inline errors.
- The lightbox follows the APG modal pattern; reduced motion is respected.
- Bilingual alt text is required to publish.
- HTML equivalents for every PDF. The statement notes that the PDFs are untagged.
- A voluntary Hebrew accessibility statement.
- axe checks in both locales.

### 6.8 Performance
- Dynamic SSR with 1–2 queries per page; the pool is cached on `globalThis` in development; `attachDatabasePool` in production.
- **`next.config.ts`:**
  - images: `qualities [75, 90]`; AVIF/WebP; `deviceSizes [640, 828, 1080, 1280, 1600, 1920, 2048]`; `localPatterns` for `/api/files/public/**` and `/brand/**`; `remotePatterns` only for `NEXT_PUBLIC_BLOB_HOST`; never `dangerouslyAllowLocalIP`;
  - `outputFileTracingIncludes` adds `./assets/fonts/**` to every route that can run `after()` outbox processing or the cron route. Use the all-routes key; verify the key syntax against the Next 16 docs in M1.
- Client JS only where needed.
- Lighthouse targets: LCP ≤ 2.5 s mobile, CLS < 0.05.

### 6.9 Demo mode (`DEMO_MODE=true`)
- A bilingual banner: "חנות הדגמה – תשלומי בדיקה בלבד; התמונות הן ציורים ברשות הציבור מאוסף מוזיאון ומשמשות כממלא מקום / Demo store – test payments only; images are public-domain museum paintings used as placeholders".
- `X-Robots-Tag: noindex, nofollow` on **all** routes via `headers()`.
- Demo items are purchasable only via mock or sandbox, and in production via mock only.
- A go-live blocker requires no unvoided mock sales on non-demo works.
- `/credits`.

### 6.10 Admin (Hebrew-first, mobile-first; noindex, no-store)

**Auth**
- `src/server/auth/options.ts` → `createAuthOptions({ db, secret, baseURL })`:
  - `emailAndPassword { enabled: true, disableSignUp: true, minPasswordLength: 12 }`;
  - `rateLimit { enabled: true, storage: 'database', customRules: { '/sign-in/email': { window: 900, max: 5 }, '/two-factor/verify-totp': { window: 900, max: 5 } } }` (exact paths, because wildcard support is checked at install);
  - `twoFactor({ issuer: 'Geula Gallery' })`;
  - an after-hook that records failed sign-ins (audited; daily alert above 10).
- `src/server/next/auth.ts` adds `nextCookies()` last. `scripts/auth-cli.ts` and `admin-create` reuse the factory.
- Sign-in uses the **client** (`authClient.signIn.email`) → `/api/auth/*` (rate-limited). `twoFactorClient` redirects to `/admin/login/2fa`.
- **`requireAdmin({ fresh?, allowUnenrolled? })` → `AdminContext`:**
  - `auth.api.getSession({ headers: await headers() })`, else redirect to login;
  - when 2FA is required and not enrolled (and `allowUnenrolled` is not set) → `/[l]/admin/enroll-2fa`, which lives **outside** `(panel)`, so there is no redirect loop;
  - `fresh` requires a session ≤ 30 min old;
  - called in `(panel)/layout.tsx` **and at the top of every admin `page.tsx`**, in every action (via `adminAction(schema, handler, { fresh })`), in every admin route handler (plus an Origin check), and in the `print/admin` layout and pages.
- Users: the painter plus at most 2 others; `admin:create` refuses a fourth.

**Navigation**
- Mobile: bottom tabs לוח בקרה / יצירות / הזמנות / הודעות / עוד, with badges and a "+ יצירה חדשה" button.
- Desktop: a side nav on the start side.

**Routes**

| Route | Purpose |
|---|---|
| `/admin` | Needs-attention cards: refunds due, NEEDS_REFUND / MANUAL_REQUIRED / UNKNOWN / unconfirmed FAILED refunds, deferred payments, LABEL_UNKNOWN, tax documents, orders to fulfil, pending-cancellation blocks, open requests, rates uncalibrated, stale cron, CRITICAL alerts. Turnover vs ₪122,833 (approximate; mock and demo excluded). Go-live checklist. |
| `/admin/artworks`, `/new`, `/[id]` | List with quick actions. Editor sections: Photos (`purpose=artwork` uploads, roles, ordering, alt he/en); Details; Size; Price & sale; Shipping (packaging, can-be-rolled, glazing, packed dimensions with "use suggestion", live class and estimate); Customs; Publish checklist. Slug locks after publish. |
| `/admin/orders`, `/[id]`, `/[id]/fulfill`, `/new` | Timeline; attempts with Recheck; refund dialog (refundable amount, fresh session); refund confirmations (UNKNOWN/FAILED → "confirmed in provider dashboard"); documents; record payment; fulfillment; manual order. |
| `/admin/inbox`, `/[id]` | Questions, quotes, (Tier B) offers; templated replies. |
| `/admin/cancellations`, `/new`, `/[id]` | Sorted by refund due date; masked IDs; duplicate linking; conversation source; legal hints. |
| `/admin/alerts` | Acknowledge; retry DEAD jobs. |
| `/admin/settings/{business,checkout,shipping,cancellation}` | Zod forms; VAT explanation; the shipping rate grid, surcharges, insurance (with "coverage confirmed on"), caps, lists, FX, "Mark calibrated today"; a read-only Providers panel (modes, gates, never secrets). |
| `/admin/account` | Password; enrol or disable TOTP; backup codes. |
| `/admin/enroll-2fa` | Forced enrolment (outside the panel). |

---

## 7. Security and privacy

**Secrets in a public repo**
- `.gitignore`: `.env*` (except `.env.example`), `.data/`, `.vercel`, `.next*/`, `openapi/`, `playwright-report/`, `test-results/`, `blob-report/`, `tests/e2e/.auth/`, `next-env.d.ts`, `*.tsbuildinfo`, `coverage/`.
- `.env.example` holds placeholders only. Cardcom test values live only in `.env.local`.
- The business identity lives only in DB settings.
- Seeds use placeholders; fixtures are anonymised; DHL fixtures are synthetic.
- **`scripts/check-secrets.ts`:**
  - flags PEM blocks; the prefixes `re_`, `sk_`, `vercel_blob_rw_`; secret-like assignments (≥ 12 characters, except `e2e-`, `test-`, `dev-only-`, `example`, `placeholder`); `NODE_TLS_REJECT_UNAUTHORIZED`;
  - finds the Cardcom test API name by **SHA-256 comparison of candidate tokens** (only the hash is in the source);
  - flags non-allowlisted emails, phones and 9-digit IDs in fixtures and seeds. The explicit allowlist covers `000000018`, `*@example.com`, `*@example.test`, `noreply@anthropic.com`, `03-000-0000`, `+972-3-000-0000`, unit-tested;
  - the history scan is `git log -p --format= | … --stdin`, which drops commit headers.
- GitHub push protection is enabled with the user's consent (§11).

**Headers** (static CSP with no nonces)

| Header | Value |
|---|---|
| `default-src` / `script-src` | `'self'` / `'self' 'unsafe-inline'` (+ `'unsafe-eval'` in development) |
| `style-src` / `img-src` / `font-src` | `'self' 'unsafe-inline'` / `'self' data: blob: https://*.public.blob.vercel-storage.com` / `'self'` |
| `connect-src` | `'self'` (+ `ws:` in development) |
| Framing and objects | `frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'` |
| `form-action` | `'self' https://secure.cardcom.solutions https://www.paypal.com https://www.sandbox.paypal.com` |
| Production | `upgrade-insecure-requests` |
| Other | HSTS (production); nosniff; Referrer-Policy (`no-referrer` on token pages); `X-Frame-Options: DENY`; Permissions-Policy; `poweredByHeader: false`; `X-Robots-Tag` per §6.9 |

**Auth and actions**
- `requireAdmin` on every admin page, print page, action and route; the proxy is optimistic only; admin PII readers require an `AdminContext`.
- Better Auth database limits (5 per 15 min).
- TOTP is required whenever `APP_URL` is https or `APP_ENV=production`.
- Fresh sessions for money and settings actions.
- Server Action origin checks; 1 MB body limit (images go only through the upload route).

**Abuse**
- `rateLimit(key, limit, windowSec)` is a Postgres fixed window. Limits live in `security/limits.ts`, scaled by `RATE_LIMIT_SCALE`.
- IPs are stored only as HMAC hashes.

| Action | Limit |
|---|---|
| Checkout start / pay order | 10 per 10 min per IP; 5 per hour per email |
| Requests | 5 per hour per IP |
| Cancellation | 20 per hour per IP |
| Return route | 60 per min per IP |
| Webhook auth failures | 30 per min per IP (authenticated requests are never limited) |
| PayPal webhook pre-verify | 60 per min per IP |
| Bad order `k` | 30 per min per IP |

- Honeypot `company_website`; minimum form age; the anti-hoarding rules of §3.5.

**Webhooks and money**
- Raw body; timing-safe comparisons; authenticate before any DB write; never fetch URLs from payloads.
- Amounts only from the DB; server-to-server sessions; exact minor units; quote-version binding.
- Refunds capped (unconfirmed FAILED rows count) and audited; never re-called blindly.
- 3DS enabled; SAQ-A redirect.

**PII**
- Redacting logger.
- Allowlisted provider payloads.
- Cancellation IDs encrypted (AES-256-GCM). **The ID is masked everywhere else**: `ack_snapshot`, the screen, emails, the `email_messages` html.
- Private files reachable only by admin session or signed URL.
- Order pages need `k`. No third-party resources on checkout, cancellation and order pages.
- The shared Cardcom terminal never receives PII.

**Retention** (`purge`; to be confirmed by the lawyer and accountant)

| Data | Retention |
|---|---|
| Paid orders, tax documents, matched cancellations | 7 years |
| Never-paid EXPIRED orders | buyer fields anonymised after 30 days |
| Unmatched cancellations | 2 years |
| `email_messages.html` | 30 days |
| `payment_events` payloads | 180 days |
| DHL raw tracking | 30 days after delivery |
| `rate_limits` | 2 days |
| `mock_payments` | 30 days |
| Closed buyer requests | 24 months |

**Privacy (Amendment 13)**
- s.11 notices at every form.
- The privacy policy lists the processors: Vercel, Neon, Resend (US storage), Cardcom, PayPal, Morning, DHL.
- Retention and the data-subject request procedure are documented.
- No analytics and no non-essential cookies.
- Admin MFA.

---

## 8. Demo content and seed pipeline

### 8.1 Local setup
**Run once at the start of M1** (absolute paths, because shell state does not persist):
```bash
brew install postgresql@18 && brew services start postgresql@18
/opt/homebrew/opt/postgresql@18/bin/psql -d postgres -c "ALTER SYSTEM SET max_connections = 200"
brew services restart postgresql@18
```
- Raising `max_connections` is a local config change to the Postgres the user approved installing. It is noted in the README and PR.
- Without it, run the streams' integration suites one after another.
- `scripts/db-setup.ts` creates `geula_dev`, `geula_test`, `geula_e2e` and the per-worktree databases over `pg` with `CREATE DATABASE … IF NOT EXISTS`-style checks, so no PATH is needed. It refuses non-localhost hosts.

**Run at the end of M1, once package.json exists:** `npm run env:init && npm ci && npm run db:setup && npm run db:reset -- --seed none --yes`.

**User quick start:** `npm ci && npm run env:init && npm run db:setup && npm run db:reset && npm run dev`.

### 8.2 `npm run demo:fetch-images` (run once in **M2** by the commerce lead; output committed)
**Download**
- Metadata in one request: `https://api.artic.edu/api/v1/artworks?ids=<16 ids>&fields=id,title,artist_display,date_display,medium_display,dimensions,image_id,credit_line,is_public_domain`. Any work whose `is_public_domain` is not true is refused.
- Images **one at a time**, ≥ 1 s apart, 3 retries with backoff, header `AIC-User-Agent: ${AIC_USER_AGENT}`.
- URL `https://www.artic.edu/iiif/2/{image_id}/full/1686,/0/default.jpg`; for 270002, `full/!2000,2000/0/default.jpg`. Assert `image/jpeg`.

**Processing:** sharp `.rotate()`, sRGB, metadata stripped, fit within 2000 px, q80 mozjpeg → `data/demo-images/<aicId>.jpg`. Width, height, bytes, sha256, blur and dominant colour go into the manifest.

**Data traps**
- Parse only the first `;` segment of `dimensions`. Five strings end in "; Framed: …": 94241, 100476, 270002, 109693, 66144.
- Keep "Attributed to" for 186427.
- Medium and surface are curated by hand (14310 is oil on board).
- 186427 is natively 1700×2250.
- Alt texts are rewritten in he and en.

**Fallback:** `lib/procedural-painting.ts` makes deterministic SVG abstracts rasterised by sharp (`--offline` or on failure), marked `fallback: true`.

AIC URLs never go through next/image.

### 8.3 Curated manifest (`data/demo-manifest.json`)
| AIC id | image_id | slug | Title (en / he) | Artist | Medium / surface | H×W cm | Series | Demo status | Price |
|---|---|---|---|---|---|---|---|---|---|
| 65912 | d9b07617-7953-5ef1-6a0f-1f593baf06a1 | landscape-no-26 | Landscape no. 26 / נוף מס׳ 26 | Marsden Hartley, 1909–10 | oil / cardboard | 30.5×30.5 | Landscapes | AVAILABLE (S) | ₪3,200 / $870 |
| 90207 | 768387ba-f972-b43b-39f7-98cb37dad883 | movement-no-10 | Movement No. 10 / תנועה מס׳ 10 | Marsden Hartley, 1917 | oil / board | 38.7×49.5 | Abstractions | AVAILABLE | ₪5,800 / $1,550 |
| 94241 | e4df4d4a-4cfb-5be8-3728-0d0bf1b44751 | the-red-room-etretat | The Red Room, Etretat / החדר האדום, אטרטה | Félix Edouard Vallotton, 1899 | oil / board | 49.2×51.3 | Interiors & Still Life | **SOLD** (order 1) | ₪7,400 |
| 14310 | 9678901a-7c1e-a9ed-aa9a-5b208fe9a80e | still-life-green-flower-vase | Still-Life with a Green Flower Vase / טבע דומם עם אגרטל פרחים ירוק | Paula Modersohn-Becker, c. 1902 | oil / board | 37.7×29.1 | Interiors & Still Life | AVAILABLE (≤ ₪5,000) | ₪4,600 / $1,250 |
| 256797 | 6744270e-1f05-e07c-18a9-ea06f180a8fb | at-the-rivers-bend | At the River's Bend / בעיקול הנהר | Lilla Cabot Perry, 1895 | oil / canvas | 65.5×81.5 | Landscapes | AVAILABLE | ₪9,800 / $2,650 |
| 100476 | 16e53257-ade2-4f5d-3521-2bc9666bc4cf | beach-at-cabasson | Beach at Cabasson (Baigne-Cul) / החוף בקבאסון | Henri Edmond Cross, 1891–92 | oil / canvas | 65.3×92.3 | Shoreline | AVAILABLE (VALUE_CAP abroad) | ₪12,500 / $3,400 |
| 212300 | ef637785-df55-adaf-b907-e3e8f59f08d6 | beach-les-grands-sables | The Beach of Les Grands Sables at Le Pouldu / חוף לה גראן סאבל | Paul Sérusier, 1890 | oil / canvas | 60×70 | Shoreline | AVAILABLE (ILS only) | ₪8,900 |
| 121377 | 56a4af78-1d23-3e2a-6119-8aa47e0cf285 | boats-at-rest | Boats at Rest / סירות במנוחה | Arthur Wesley Dow, c. 1895 | oil / canvas | 66×91.4 | Shoreline | **ON_HOLD (RESERVED_OFFLINE)** | ₪11,800 |
| 72801 | 3ae75415-0551-ae17-c478-3b8687a6f246 | icebound | Icebound / לכוד בקרח | John Henry Twachtman, c. 1889 | oil / canvas | 64.2×76.6 | Landscapes | AVAILABLE (`can_be_rolled`) | ₪9,200 / $2,450 |
| 64754 | 4425984b-e241-6413-1404-cdac0fb06518 | moonrise | Moonrise / זריחת הירח | George Inness, 1891 | oil / canvas | 76.5×64.1 | Landscapes | **SOLD** (order 2) | ₪10,400 / $2,800 |
| 109693 | c7686c63-3aca-64b6-6710-02f34ccd0767 | banks-of-the-durance | The Banks of the River Durance at Saint Paul / גדות הדוראנס | Paul Camille Guigou, 1864 | oil / canvas | 62×148 | Landscapes | AVAILABLE, **CRATE + quote_only** | ₪18,000 / $4,850 |
| 71573 | a67c4473-57a4-9807-a94e-1136d3daf876 | a-holiday | A Holiday / יום חופש | Edward Henry Potthast, c. 1915 | oil / canvas | 76.4×101.8 | Shoreline | AVAILABLE (L) | ₪14,500 / $3,900 |
| 186427 | 4457ef17-3808-b015-5deb-ad8a961eb970 | antibes | Antibes / אנטיב | Attributed to Henri Edmond Cross, 1907 | watercolor with black chalk / paper | 42×31.7 | Works on Paper | AVAILABLE (S) | ₪1,900 / $520 |
| 30928 | 7182fe78-c4dd-c30d-2ae7-d1e018aacfd8 | terrace-bridge-central-park | The Terrace Bridge, Central Park / גשר הטרסה | Maurice Prendergast, 1901 | watercolor over graphite / paper | 38.8×56.9 | Works on Paper | **SOLD** (order 3) | ₪2,600 |
| 270002 | 15a0f792-0c21-406e-3e4d-ac8c2393c873 | interior-music-room | Interior. The Music Room, Strandgade 30 / פנים. חדר המוזיקה | Vilhelm Hammershøi, 1907 | oil / canvas | 70×59 | Interiors & Still Life | **NOT_FOR_SALE** | – |
| 65930 | 2a328b12-cb68-19e8-3843-b2160f007813 | still-life-no-15 | Still Life No. 15 / טבע דומם מס׳ 15 | Marsden Hartley, c. 1917 | oil / board | 59.4×49.5 | Interiors & Still Life | AVAILABLE | ₪6,900 / $1,850 |

- **Alternates:** 40549, 66144, 65920, 62393. Sold share: 3/16 ≈ 19%.
- **Packaging defaults** (explicit):
  - canvas → STRETCHED_BOX (depth 30 mm); board or cardboard → FLAT_BOX (10 mm); paper → FLAT_BOX (2 mm); 109693 → CRATE;
  - **packed length and width = artwork + 120 mm total** (canvas or board) or **+ 80 mm total** (paper); packed height = depth + 80 mm;
  - packed weight = 1,500 g + 6,000 g × artwork area (m²);
  - rolled tube = the shorter side + 100 mm, × 260 × 260 mm.
- **Expected classes** (unit-tested with these numbers):

  | Work | Packed mm | Actual g | Volumetric kg | Class |
  |---|---|---|---|---|
  | landscape-no-26 | 425×425×90 | 2,058 | 3.25 | S |
  | antibes | 500×397×82 | 2,299 | 3.26 | S (longest exactly 50.0 cm) |
  | a-holiday | 1138×884×110 | 6,167 | 22.13 | L (oversize) |
  | icebound (tube) | 742×260×260 | 4,451 | 10.03 | M |
  | banks-of-the-durance | crate | – | – | QUOTE |

- **Descriptions** say honestly: "Demo listing using a public-domain painting by <artist> (<date>), The Art Institute of Chicago (CC0)".
- With the USD 2,500 DHL cap, international checkout works for landscape-no-26, antibes, movement-no-10, still-life-no-15, still-life-green-flower-vase and icebound. Higher-value works route to quote.

### 8.4 Seed (`scripts/seed/index.ts` registry; idempotent upserts; called by `db:reset`)
| Module | Owner | Contents |
|---|---|---|
| `settings.ts` | M1 | Business profile placeholders ("Geula Gallery / גלריה גאולה", legal name "(למילוי)", ID `000000018`, phones `03-000-0000` / `+972-3-000-0000`, `studio@example.com`, `notificationEmail=ADMIN_EMAIL`, OSEK_PATUR, `completed=false`); checkout defaults; STATUTORY_MAX; shipping defaults (below) |
| `catalog.ts` | **M2** | 5 series and 16 artworks (`is_demo=true`) ingested via `media/ingest.ts` and the StorageAdapter; OG images; 121377 ON_HOLD RESERVED_OFFLINE; 270002 NOT_FOR_SALE; the three sold works get their state from `orders.ts` |
| `orders.ts` | WS6 (M2 ships a stub that marks the three works SOLD through `sales` OFFLINE `is_mock`) | Sample orders below |
| `users.ts` | M1 | `admin:create` logic |

**Shipping seed**
- Placeholder rates (ILS):

  | Zone | S | M | L |
  |---|---|---|---|
  | IL | 60 | 120 | 250 |
  | EUROPE | 220 | 480 | 1,100 |
  | NORTH_AMERICA | 260 | 560 | 1,300 |
  | REST_OF_WORLD | 300 | 650 | 1,500 |

- Surcharges: fuel 20% (placeholder); DHL Demand 2026-10-01 to 2027-02-05 at ₪40 (placeholder, enabled); Elevated Risk disabled.
- Insurance: enabled for DHL at 1.5% with a ₪50 minimum and `maxInsuredIls` 10,000 (placeholder); `coverageConfirmedAt: null` (a go-live blocker).
- DHL cap USD 2,500; deny list IR, SY, LB, IQ; dated FX; `calibratedAt: null`.

**Sample orders** (`orders.ts`). Each has a SUCCEEDED MOCK attempt bound to its quote version, an ONLINE `is_mock` sale, an ISSUED mock receipt, and consistent invariants. No outbox jobs are created.
1. **94241**: IL buyer, ILS, DELIVERED via manual "Israel Post". Plus a RECEIVED cancellation due in 9 days.
2. **64754**: US buyer, QUOTE link order, USD, locked shipping, mock waybill, IN_TRANSIT.
3. **30928**: IL local pickup, PAID / AWAITING_FULFILLMENT.

**Painter account (`npm run admin:create`)**
- A script-local `betterAuth(createAuthOptions(...))` with sign-up enabled calls `auth.api.signUpEmail(...)`. Fallback: `internalAdapter`.
- It never prints the password and refuses beyond 3 users.
- `SEED_E2E_USERS=true` adds `e2e-admin@example.test` and `e2e-2fa@example.test`.

**`scripts/db-reset.ts [--db <name>] [--seed demo|none] --yes`**: refuses non-localhost hosts → drops the `public` and `drizzle` schemas → migrates (drizzle `node-postgres/migrator`) → runs the seed registry.

---

## 9. Build order, parallel workstreams and contracts

### 9.1 Milestones
| Milestone | Owner | Deliverables | Acceptance |
|---|---|---|---|
| **M0 Bootstrap** | integrator | §11.1: README.md + `.gitignore` on unborn `main` → commit → push → `git switch -c feat/gallery-v1` | `git ls-remote origin main` returns one commit |
| **M1 Foundation** | 1 agent, sequential | Steps 1–15 below | M1 acceptance below |
| **M2 Vertical slice + demo catalog** | 1 agent (commerce lead) | Listed below; tag `contracts-v1` | listed below |
| **M3 Parallel growth** | up to 4 agents in git worktrees off `contracts-v1` (§9.2) | stream scopes | each stream: its own tests plus `npm run verify` green |
| **M4 Integrate & harden** | integrator | Rebase WS5 → WS2 → WS3 → WS1 → WS4 → WS6 onto `feat/gallery-v1`, with `verify` after each and `--ff-only`. Remove remaining stubs. Full E2E, axe, headers, live Cardcom check, agent-verifiable QA, docs, history secret scan, push, PR. | §10.7 |

**M1 steps**
1. Postgres: the §8.1 "once at the start" commands only.
2. **Scaffold** into the scratchpad, because README.md already exists in the repo:
   ```bash
   npx --yes create-next-app@16.3.8 "$SCRATCH/scaffold" --ts --tailwind --biome --app --src-dir \
     --import-alias "@/*" --use-npm --disable-git --skip-install --agents-md --no-react-compiler --empty --yes
   rsync -a --exclude .git --exclude README.md --exclude .gitignore --exclude node_modules "$SCRATCH/scaffold/" ./
   ```
   Merge the template's `.gitignore` lines into ours, and delete `src/app/layout.tsx` and `page.tsx`.
3. **Pin every dependency with `npm i -E`.** The full list, plus **every §10.7 npm script** (pointing at stub scripts where needed), is added now.
   - Runtime: `next@16.3.8 react@19.3.0 react-dom@19.3.0 next-intl@4.14.8 use-intl@4.14.8 drizzle-orm@0.45.3 pg@8.23.1 @vercel/functions@3.9.9 better-auth@1.7.7 @better-auth/drizzle-adapter@1.7.7 zod@4.6.5 server-only@0.0.1 sharp@0.35.5 @vercel/blob@2.8.0 yet-another-react-lightbox@3.32.2 qrcode@1.5.4 resend@6.31.0 react-email@6.11.0 @react-pdf/renderer@4.9.0 openapi-fetch@0.17.0`.
   - Dev: `typescript@5.9.3 @types/node@24.19.0 @types/react@19.3.0 @types/react-dom@19.3.0 @types/pg@8.23.1 @types/qrcode@1.5.6 @biomejs/biome@2.5.15 tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 drizzle-kit@0.31.11 openapi-typescript@7.13.0 tsx@4.23.15 auth@1.7.7 vitest@5.0.3 vite@8.3.1 @vitejs/plugin-react@6.1.1 @playwright/test@1.63.0 @axe-core/playwright@4.13.0`.
   - Then `npx @biomejs/biome migrate --write`; `engines.node "24.x"`; `npx playwright install chromium`.
   - **After M1, package.json and the lockfile change only through a dependency-change request**: the integrator commits it on `feat/gallery-v1` and the streams rebase.
4. **Config:**
   - tsconfig strict with `noUncheckedIndexedAccess`;
   - `next.config.ts`: `withNextIntl`, `globalNotFound`, images, headers, `outputFileTracingIncludes`, `distDir: process.env.NEXT_DIST_DIR ?? '.next'`;
   - `biome.json`: restricted imports, plus `files.includes` negations for generated code, `drizzle`, `data`, `openapi`;
   - `vercel.json`, `.npmrc`, `.nvmrc`.
5. `src/server/env.ts` (with the derivations and cross-field rules), `public-env.ts`, `instrumentation.ts`, `.env.example`, `scripts/env-init.ts`.
6. **Schema:**
   - the complete §3 schema, with `AnyPgColumn` for cycles;
   - `src/server/auth/options.ts` + `scripts/auth-cli.ts` → `npx auth@1.7.7 generate --config scripts/auth-cli.ts --output src/server/db/schema/auth.ts` (flags checked with `--help`);
   - `npm run db:generate` → `drizzle/0000_*.sql`;
   - `db-setup`, `db-migrate`, `db-reset`, and the seed registry with `settings.ts` and `users.ts`.
7. **i18n and shell:** routing, request, navigation, `namespaces.ts`, proxy; root layout (fonts, tokens); `global-not-found`; the site, checkout, print, print/admin and admin layouts with header and footer **including the cancel link**; `DemoBanner`; all `components/ui/*`.
8. **Message namespaces:** every file in §9.4, with real keys for `common` and `emails-core`.
9. **Auth:** `next/auth.ts`; the route handler; login, 2FA and enroll-2fa pages; `guards.ts` (`requireAdmin`, `AdminContext`); `actions.ts`; `effects.ts`; `security/*` (including `limits.ts`); audit; alerts; `admin-create`.
10. **Storage and uploads:** local driver, file routes, `media/ingest.ts`, and **`/api/admin/uploads` with all three purposes**.
11. **Outbox, email, cron:** the outbox core plus stub handler files for all 5 kinds; the email core (log driver, render, Layout, stub templates for every id); the cron route plus stub files for all 5 jobs; `scripts/cron.ts` (HTTP client).
12. **Contracts:**
    - the §9.3 files with typed stubs, **including stub adapters** for cardcom, paypal, morning, gateway, dhl and resend;
    - `content/disclosure.ts` signatures;
    - every `src/lib/*` util fully implemented, except the body of `deadlines.ts`;
    - `settings/schemas.ts`;
    - `gen:api-types` run (DHL: try 3.3.2 first) with the generated types committed.
13. **Spikes**, each with a 1-hour fallback:
    - (a) react-pdf Hebrew+English disclosure sample, inspected with the Read tool. Fallback: separate `<Text>` runs, or HTML only.
    - (b) Render react-email in a Route Handler and inside `after()` from a Server Action. Fallback: `serverExternalPackages`.
    - (c) `next build` with `[locale]` as the only root layout plus `force-dynamic`.
    - (d) `next start` renders a PDF using fonts from the traced output.
14. **Test harness:**
    - Vitest projects `unit`, `contract`, `integration` (node; `server-only` alias; an integration `globalSetup` that migrates `TEST_DATABASE_URL`, refusing non-localhost; `fileParallelism:false`; truncation per test);
    - `tests/helpers/*` including `race.ts` (dedicated `pg.Client`s plus a barrier) and `factories/core.ts`;
    - `playwright.config.ts` and a smoke spec;
    - `check-secrets`, `dependabot.yml`, AGENTS.md rules.
15. Run the §8.1 "end of M1" commands.

**M1 acceptance**
- `npm run lint && npm run typecheck && npm run check:secrets` pass.
- `npm run db:reset -- --seed none --yes` works.
- `npm run build` passes.
- `npm test && npm run test:integration` pass, including `schema-constraints` and `architecture`.
- `curl -sI localhost:3000/` returns 307 → `/he`.
- `/he` has `dir="rtl"`; `/en` has `dir="ltr"`.
- Logged out, `/he/admin` goes to login; sign-in works; with `ADMIN_REQUIRE_2FA=true` a fresh user lands on enroll-2fa with no loop.
- Smoke E2E green; spike results recorded in `docs/architecture.md`.

**M2 deliverables**
- `demo:fetch-images` run, with the manifest and images committed; `seed/catalog.ts` (all 16 works, statuses, packaging); the `orders.ts` stub.
- Minimal home, works and artwork pages with `LiveBuyBox`.
- `rates.ts` and `rules.ts` for IL plus the international basics; checkout page and actions; reservations (lock-before-insert, caps under advisory locks); `requote.ts`.
- The mock provider and mock-pay; webhook (auth-first, `processed_at`, 500 on failure) and return routes.
- The **full** `finalizeAttempt` / `capture` / `applySuccessfulPayment` / NEEDS_REFUND paths, including deferral and quote binding; `refunds.ts` with the two-phase states.
- The order page; the outbox processor with `order-confirmation` (inline disclosure) and `painter-new-order`; mock tax documents; admin orders list and detail with Recheck and manual tracking; the `reconcile` job.

**M2 acceptance**
- `tests/integration/{reserve-race,finalize,capture-race,refunds}.test.ts` green.
- `tests/e2e/{purchase-il,webhook,order-retry,race}.spec.ts` green. In `purchase-il`, the PDF-attachment assertion is `test.fixme` until WS6.
- `npm run verify` green.

### 9.2 Parallel workstreams (M3); each owns only its listed paths
| Stream | Owns | Scope | Exit tests |
|---|---|---|---|
| **WS1 Storefront & SEO** | `(site)/{page,works/**(except request),about,contact,credits}`; `components/{site,artwork}/**`; `server/catalog/{queries,commerce-state}.ts`; `sitemap.ts`, `robots.ts`; `messages/*/{catalog,artwork}.json`; `tests/helpers/factories/storefront.ts` | Grid, filters, strip, archive, full artwork page, lightbox, JSON-LD, metadata, OG, conditional "insured" copy | e2e `storefront`, `a11y` (public), `not-found` |
| **WS2 Commerce core** | `server/checkout/**`; `server/payments/{finalize,apply,capture,refunds,offline,reconcile,webhook,registry,sweep,post-success}.ts`; `providers/mock.ts`; `(checkout)/**`; `(site)/orders/**`; `components/{checkout,orders}/**`; `outbox/handlers/{refund-payment,refund-settled,issue-tax-document,issue-credit-note}.ts`; `taxdocs/{registry,issue,mock}.ts`; `jobs/{reconcile,outbox}.ts`; templates `payment-review`, `purchase-not-completed`, `refund-issued`, `receipt`, `checkout-link`; `messages/*/{checkout,orders,emails-commerce}.json`; `factories/commerce.ts` | International checkout, capture and review flows, retry and release, link orders and requote, refunds (all states, matching), offline payments, the tax-document pipeline, expiry, sweep and tail logic, guards | integration `finalize`, `capture-race`, `refunds`, `outbox`, `taxdocs`, `expire-job`, `link-orders`, `webhook-replay`, `limits`; e2e `international`, `late-payment`, `capture-mode`, `tamper`, `order-retry` |
| **WS3 Shipping & fulfillment** | `server/shipping/**`; `admin/(panel)/orders/[id]/fulfill/**`; `admin/(panel)/settings/shipping/**`; `components/fulfillment/**`; `(print)/print/admin/{packing-slip,commercial-invoice}/**`; `jobs/tracking.ts`; templates `shipment-update`, `ready-for-pickup`; `tests/fixtures/dhl/**`; `messages/*/{shipping,emails-shipping,documents-shipping}.json`; `factories/shipping.ts` | Full rates and rules (insurance cap), customs, carriers (mock, manual, DHL), the claim protocol, packing photos via `purpose=packing`, export declaration, disclosure guards on pickup and delivery, the pending-cancellation block, tracking, the settings editor | unit `shipping-rates`, `shipping-rules`, `dhl-builder`, `dhl-map`; contract `carrier`; integration `shipments`, `tracking-job`; e2e `fulfill`, `shipping-rules` |
| **WS4 Admin & requests** | `admin/(panel)/{layout,page,artworks/**,inbox/**,orders/new/**,orders/page,orders/[id]/page,alerts/**,account/**,settings/{business,checkout}/**}`; `admin/{login,enroll-2fa}/**`; `components/admin/**`; `api/admin/blob-upload`; `server/catalog/{mutations,publish}.ts`; `server/requests/service.ts`; `(site)/works/[slug]/request/**`; templates `request-ack`, `request-reply`, `painter-new-request`; `messages/*/{requests,emails-requests,admin-shell,admin-catalog,admin-orders,admin-settings}.json`; `factories/admin.ts` | Dashboard, artwork editor, offline hold, sale and relist, inbox → quote links (offers in Tier B), manual order and record payment, refund confirmation UI, alerts, settings, account and 2FA | e2e `admin-artwork`, `admin-offline`, `quote`, `offer` (Tier B), `manual-order`, `admin-auth` |
| **WS5 Integrations** | `providers/{cardcom,cardcom-map,paypal,paypal-map,paypal-verify}.ts`; `taxdocs/{morning,gateway}.ts`; `integrations/http.ts`; `email/drivers/resend.ts`; `scripts/check-*.ts`; `tests/contract/**` (provider suites); `tests/fixtures/{cardcom,paypal,morning}/**` | Adapters per §4.2–4.3; `RECORD_FIXTURES`; live checks | contract suites green; `check:cardcom` passes on the test terminal |
| **WS6 Compliance & documents** | `(site)/{cancel,legal}/**`; `content/**` (implementing `disclosure.ts`); `server/cancellations/**`; `server/documents/**`; `(print)/print/{disclosure,receipt}/**`; `(print)/print/admin/{coa,studio-notice}/**`; `components/docs/**`; `jobs/{daily,purge}.ts`; `server/{golive,invariants}.ts`; `src/lib/deadlines.ts` (body); `admin/(panel)/{cancellations/**,settings/cancellation/**}`; templates `order-confirmation` (final), `cancellation-ack`, `return-instructions`, `painter-cancellation`, `admin-alert`; `outbox/handlers/send-email.ts`; `scripts/seed/orders.ts`; `assets/fonts/**`; `docs/**`; `messages/*/{cancel,legal,emails-compliance,documents-compliance}.json`; `factories/compliance.ts` | Cancellation (public, admin, duplicates, deadlines, conversation default), disclosure HTML (PDF in Tier B), COA (Tier B), studio notice, legal drafts and notices, accessibility statement, daily and purge jobs, go-live and invariants, sample-order seed, docs | unit `deadlines`, `legal-content`, `aic-dimensions`; integration `cancellations`, `invariants`, `purge`; e2e `cancellation-il` |

**Agent allocation.** The six ownership units stay disjoint, but **at most 4 agents run at once**, to limit rebase risk and machine load:

| Agent | Streams, in order |
|---|---|
| A | WS2 |
| B | WS5 (the Cardcom check is quick and Tier A), then WS3 |
| C | WS4 |
| D | WS6 (Tier A compliance first), then WS1 polish (M2 already ships minimal storefront pages) |

Six agents may run only if Postgres connections and CPU allow.

**Worktrees.** `git worktree add ../gg-ws<N> -b ws/<name> contracts-v1`, each with:
- its own `.env.local` (DB names `geula_{dev,test,e2e}_ws<N>`, `PORT 30<N>0`, `E2E_PORT 31<N>0`, `NEXT_DIST_DIR=.next-ws<N>`; `APP_URL` set to its own port, with webhook and auth URLs derived from it);
- its own `npm ci`;
- pools of dev 5 and tests 4. Race tests use dedicated clients, not the pool.

### 9.3 Interface contracts frozen at `contracts-v1`
**Schema and shared libraries**
- `src/server/db/schema/**` and `drizzle/**` are **integrator-only**. Changes go through a schema-change request.
- `src/lib/*`: implemented in M1. `deadlines.ts` has frozen signatures (`cancellationWindow`, `refundDueAt`, `changeOfMindFee`).
- `src/content/disclosure.ts`: `buildPreContract(input: PreContractInput, locale): PreContractDoc` and `buildDisclosure(input: DisclosureInput, locale): DisclosureDoc` (M1 stub with real types).

**Domain contracts**
- `src/server/domain/*`.
- `payments/types.ts` (§4.2), plus:
  - `finalizeAttempt`, `applySuccessfulPayment`;
  - `requestRefund({ attemptId, amountMinor, reason, cancellationId?, requestedBy })`, `executeRefund(refundId)`, `confirmManualRefund(refundId, reference, ctx)`, `confirmRefundFailure(refundId, ctx)`;
  - `recordOfflinePayment`.
- `checkout/*`:
  - `getCheckoutQuote`, `startCheckout`, `startPaymentForOrder`, `requoteOrder`, `createLinkOrder`, `releaseReservation`, `expireStaleOrders`;
  - `lockArtworks`, `isReservable`, `isSellable`, `detectConversation`.
- `shipping/types.ts`.
- `taxdocs/types.ts`.
- `email/types.ts` (the `EmailTemplateId` union and props).
- `outbox/types.ts` (5 kinds).
- `jobs/index.ts`.
- `settings/schemas.ts`.
- `next/{guards,actions,effects}.ts` (`requireAdmin`, `AdminContext`, `adminAction`, `publicAction`).
- The upload API: `POST /api/admin/uploads?purpose=…` → `{ fileKey, imageId? }`.
- Catalog DTOs.
- The seed registry module list.

**Shared test and UI pieces**
- `tests/helpers/{db,mock-webhook,mailbox,totp,race}.ts` and `factories/core.ts` are frozen. Each stream adds its own `factories/<stream>.ts`.
- `components/ui/*`: new files allowed, no edits.

### 9.4 Conflict avoidance
- **Frozen after M1:** package.json and the lockfile (change requests only), `next.config.ts`, `src/proxy.ts`, the root layout, `src/i18n/*` (including `namespaces.ts`, which already lists every file below), `env.ts`, `globals.css` tokens, AGENTS.md.
- **Message files, one owner each:**

  | Owner | Files |
  |---|---|
  | M1 | `common`, `emails-core` |
  | WS1 | `catalog`, `artwork` |
  | WS2 | `checkout`, `orders`, `emails-commerce` |
  | WS3 | `shipping`, `emails-shipping`, `documents-shipping` |
  | WS4 | `requests`, `emails-requests`, `admin-shell`, `admin-catalog`, `admin-orders`, `admin-settings` |
  | WS6 | `cancel`, `legal`, `emails-compliance`, `documents-compliance` |

- Route folders do not overlap.
- The registries (outbox handlers, jobs, email templates, adapters, seed modules, admin nav) are created in M1 with stub files.
- Each stream writes its own E2E spec files and factories.

### 9.5 Tier discipline
- Each stream finishes its Tier A scope before touching Tier B.
- The integrator cuts Tier B items that are not green by M4 and lists them in the PR.
- P0 compliance is never cut: the cancellation link and flow, refund deadlines, disclosure delivery, the receipts pipeline, and price display.

### 9.6 AGENTS.md project rules
- Commands; the ownership map; the principles (§1.1).
- Minor units; logical CSS only.
- `server-only` everywhere in `src/server`; no `next/*` in services.
- Pass `locale` explicitly; never trust client totals.
- **The lock order, and locking before FK inserts.**
- `requireAdmin` on every admin page.
- Scripts call cron over HTTP.
- No secrets or PII in commits.
- Conventional Commits with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## 10. Verification

### 10.1 Unit tests (`tests/unit`)
- **`money`, `vat`:** formatting with RLM/NBSP normalisation; no decimals for whole amounts; `fromDecimal` rejects > 2 places; included VAT at 18%; 0 for patur and exports; ceiling by year.
- **`deadlines`:**
  - 14 days from the later of delivery and disclosure; cancellation before delivery;
  - 4 months only with eligibility **and** a conversation;
  - refund due = received + 14 days; DST boundaries;
  - fee: ₪1,500 → ₪75 and ₪20,000 → ₪100; EU and defect → 0; USD;
  - COMPLETED eligibility: 4 months for conversation orders.
- **`shipping-rates`:**
  - class boundaries; divisor; overrides; > 70 kg → QUOTE;
  - surcharge windows inclusive on 2026-10-01 and 2027-02-05;
  - **insured value capped before the premium**; `insured=false` when disabled or for pickup or manual;
  - USD lock; tube maths;
  - **the §8.3 expected-class table with exact numbers.**
- **`shipping-rules`:** deny list and IQ toggle; ZONE_DISABLED; GB_LOW_VALUE; EU notice; US notices; formal entry; VALUE_CAP; NOT_INTERNATIONAL; Latin-only addresses.
- **`pricing`:** IL → ILS; USD rules.
- **`requote`:** a version bump on any amount, method or currency change; refused while in flight.
- **Utilities:** `il-id`, `aic-dimensions`, `tokens`, `mock-signature`, `redact` (including ID masking in `ack_snapshot` and email props), `crypto`, `state-machines`, `limits` (scale and production guard).
- **Provider maps:**
  - `cardcom-map`: all states and mismatches; non-zero refund → FAILED; ListTransactions parsing;
  - `paypal-map`: states, payee merchant_id match and mismatch, refund `custom_id`, invoice_id;
  - `morning-map`;
  - `dhl-builder` and `dhl-map`.
- **`email-templates`:** `lang`/`dir`; footer identity without the ID number; channels; no advertising template.
- **`legal-content`:** every s.14C(a) element present; forbidden phrases absent; **`business_profile.idNumber` never appears in rendered legal pages or the footer.**
- **`architecture`** (§2.2, including the `requireAdmin` rule and the script-import rule), **`csp`**, **`check-secrets`** (allowlist, hashed Cardcom name).

### 10.2 Contract tests (`tests/contract`)
- Shared suites: payment providers (mock, cardcom fixtures, paypal fixtures); tax documents (mock, morning); carriers (mock, dhl).
- They check required fields, redirect extraction, every state mapped, minor units, idempotency headers, ProviderNotConfigured paths, and that authentication accepts good input and rejects bad.
- Live blocks are gated by `*_CONTRACT` and skip cleanly without credentials.
- The spec-drift check is Tier B and opt-in.

### 10.3 Integration tests (`tests/integration`, real Postgres)
| Test | Scenario |
|---|---|
| `schema-constraints` | second active sale and second winner → 23505; reservation CHECKs; IL ⇒ ILS; demo ⇒ not LIVE; total CHECK; `reserved_by_order_id` restrict |
| `reserve-race` | **20 dedicated `pg.Client`s released together by a barrier** → exactly 1 hold; `pg_stat_database.deadlocks` unchanged; at least one lock wait observed; takeover expiry; 2-item all-or-nothing; caps under advisory locks; per-artwork budget, cooldown and hold span; `client_request_id` 23505 resumes |
| `finalize` | normal; 10 concurrent finalizes → 1 sale and 1 job set; webhook ×3 plus return; late-free → PAID; late-taken → refund, receipt and credit note; duplicate; cancelled order; mismatch → MANUAL_REQUIRED refund with deadline; drift; **stale quote: method changed between attempts, the old attempt paid → STALE_QUOTE refund, order still AWAITING_PAYMENT**; **deferral while another attempt is CAPTURING**; `refunded` / `partially_refunded` states; unpublished-but-free late payment → PAID |
| `capture-race` | parallel finalize → capture once; lost before capture → CANCELED; **capture timeout → 15 min pass → a second buyer cannot reserve → reconcile re-enters and captures with the same key**; capture watch → CANCELED; review → COMPLETED / DENIED (hold shortened to ≤ 35 min) |
| `refunds` | cap (including unconfirmed FAILED); concurrent 60% refunds → one rejected; **crash after the provider call (IN_FLIGHT lease) → UNKNOWN, no second call**; Cardcom non-zero → FAILED and the retry blocked until confirmed; PayPal webhook for our own refund before `provider_refund_id` is stored → matched, not EXTERNAL; MANUAL_REQUIRED → MANUAL_DONE; REFUND_SETTLED failure is retried and the refund row stays final |
| `webhook-replay` | processing throws once → 500 → redelivery processed; reconcile replays unprocessed events; REVERSED failure then retry → fulfillment blocked; forged requests never write to the DB |
| `outbox` | dedupe; SKIP LOCKED; backoff; lease; DEAD; email idempotency; credit note reschedules while the receipt is UNKNOWN |
| `taxdocs` | marker search before re-issue; gateway copy; none; patur credit note; receipts for NEEDS_REFUND payments |
| `expire-job` | releases holds; skips in-flight attempts; link requests expire; Cardcom tail polling; live sweep with an unmatched transaction → CRITICAL (fixture) |
| `link-orders` | 48 h hold; locks; pay extends; requote; expiry |
| `cancellations` | auto-match; **double submission and web-then-phone notices both stored**; window including 4 months; conversation detected from a buyer request; COMPLETED order cancellation → CANCELLED; fee; EU; due from notice; relist |
| `shipments` | manual transitions; label claim and LABEL_UNKNOWN; export declaration; RECEIVED-cancellation block and override; pickup collection needs the disclosure |
| `tracking-job`, `offline`, `rate-limit`, `limits` (production values), `invariants`, `purge` | as named |

### 10.4 E2E (`tests/e2e`, Playwright 1.63.0)
**Setup**
- `webServer.command`: `npm run db:reset -- --db ${E2E_DB} --seed demo --yes && npm run build && npm run start -- -p ${E2E_PORT}`.
- `webServer.env`:
  - `DATABASE_URL`, `APP_URL=http://localhost:${E2E_PORT}`, **`PUBLIC_WEBHOOK_BASE_URL` and `BETTER_AUTH_URL` set to the same value**;
  - `APP_ENV=test`, `NEXT_DIST_DIR=.next-e2e`;
  - mock providers, log email, local storage (`.data/e2e-uploads`);
  - `MOCK_CARRIER_DELIVERY_SECONDS=1`, `DEMO_MODE=true`, `SEED_E2E_USERS=true`;
  - **`RATE_LIMIT_SCALE=100`, `FORM_MIN_AGE_MS=0`**;
  - fixed `e2e-` secrets.

  Process env overrides `.env.local`, and the boot assertion catches leaks.
- Specs use unique buyer emails (`factories/core.ts` `uniqueBuyer()`) and trigger cron through Playwright's `request` fixture.
- `globalSetup` signs in once and saves `tests/e2e/.auth/admin.json`.
- **Projects:**
  - `desktop-chromium`: all specs except `admin-auth`;
  - `mobile-chromium` (Pixel 7): `@mobile` / `@smoke`;
  - `auth-limits`: `admin-auth`, with `dependencies: ['desktop-chromium']` so it runs last;
  - WebKit is P1.

**Specs**

| Spec | Scenario |
|---|---|
| `smoke` | redirects; `html[dir][lang]`; banner; X-Robots-Tag; cancel link on home, works, artwork, about, legal, checkout and order pages |
| `storefront` | URL filters; Sold as text; strip ≤ 4; JSON-LD availability; keyboard lightbox (mirrored arrows in he, Esc, focus return, live region); "insured" shown only when configured |
| `purchase-il` | full IL purchase → Sold → emails (PDF attachment once WS6 lands) → mock receipt → admin sees the order |
| `race` | two contexts → one reaches mock-pay, the other sees "just reserved" → Sold |
| `webhook` | "Pay without returning" → PAID; forged → 401; a valid webhook for an unpaid ref leaves it unpaid |
| `order-retry` | cancel → retry → paid; release → available |
| `late-payment` | hold lost → late pay → `purchase-not-completed`, refund, alert; free variant → PAID |
| `capture-mode` | approve → capture → paid; approval after loss → not captured; retry refused during review |
| `tamper` | duplicate webhooks → one sale; tampered amount → not paid, CRITICAL alert |
| `international` | US destination: Latin validation, DAP required, USD total, pay |
| `shipping-rules` | IR hidden; GB low value → quote; VALUE_CAP → quote; crate → quote only |
| `quote` | quote request → admin quotes → link → requote by method change → pay |
| `offer` (Tier B) | offer → accept → link → pay; auto-decline |
| `manual-order` | manual order → record exact transfer → PAID + disclosure email |
| `cancellation-il` | POST form, name + ID only; **the URL never contains the ID**; review → confirm → acknowledgement + email (ID masked) → resubmit accepted as a possible duplicate → admin match, fee, refund, credit note, relist |
| `fulfill` | packing photo upload (a 5 MB fixture via `purpose=packing`); mock label; tracking cron → DELIVERED; printables render; label only via signed URL; pickup collection blocked until disclosure confirmed |
| `admin-artwork` | create, upload, publish blocked until alt filled, visible; price change confirmed and audited |
| `admin-offline` | hold toggles the badge; offline sale during a hold → later payment refunded |
| `admin-security` | **a forged `better-auth.session_token` cookie on admin pages and `/print/admin/packing-slip/<id>` → redirect or 403, with no PII in the body**; enroll-2fa without a loop |
| `admin-auth` (project `auth-limits`) | 6 quick bad logins → 429; TOTP enrolment → re-login requires a code |
| `a11y` | axe on home, works, artwork, checkout, cancel, order, admin login and editor, he + en → zero serious or critical |
| `headers`, `not-found`, `mobile` | headers; 404s; sticky bar, scroll-snap, touch targets, checkout at 360 and 390 px; screenshots saved for agent review |

### 10.5 Live sandbox checks (opt-in; never in `verify`)
**Cardcom, today:**
- set the public test-terminal values in `.env.local`, `CARDCOM_MODE=test`, `PAYMENT_PROVIDERS=cardcom,mock`;
- run `CARDCOM_CONTRACT=1 npm run test:contract` and `npm run check:cardcom` (Create ₪1 → GetLpResult unpaid → print URL → redacted fixtures);
- check the Hebrew hosted page;
- `--wait` lets a human pay with a test card (numbers unconfirmed; ask Cardcom);
- run one full local checkout with Cardcom, finalized via the return route;
- if Cardcom rejects a localhost `WebHookUrl`, use a tunnel only with the user's approval, otherwise document it.

**PayPal, Morning, DHL:** the same pattern once credentials exist (DHL: api-mock first). Results go in the PR.

### 10.6 QA checklist (`docs/testing.md`)
**Agent-verifiable** (automated or checked by inspecting artefacts; ticked in the PR)
- RTL mirroring, from Playwright screenshots at 360, 390 and 1280 px in he and en, which the agent inspects with the Read tool.
- Prices, dimensions and phones not mirrored.
- Keyboard-only checkout, lightbox and dialogs.
- axe results.
- A4 print output of every printable via `page.pdf()`, inspected.
- Emails in he and en from `email_messages`.
- Reduced-motion emulation.
- Lighthouse only if `npx lighthouse` runs headless locally; otherwise a user item.

**For the user or painter** (listed unchecked in the PR)
- VoiceOver in he and en.
- The editor on a real phone, uploading from the camera roll.
- 200% zoom.
- Lighthouse on a real device.
- Final legal and visual sign-off.

### 10.7 Commands and the meaning of "done"
**Scripts** (all present from M1)
- Basic: `dev`, `build`, `start`, `lint` (`biome check .`), `typecheck` (`next typegen && tsc --noEmit`), `check:secrets`.
- Tests:
  - `test` (`vitest run --project unit --project contract`), `test:integration`, `test:contract`, `test:e2e`;
  - `verify` = lint + typecheck + check:secrets + test + test:integration;
  - `verify:all` = verify + build + test:e2e.
- DB: `db:setup`, `db:generate`, `db:migrate`, `db:reset`, `db:seed`.
- Other: `admin:create`, `env:init`, `demo:fetch-images`, `gen:api-types`, `cron` (HTTP), `check:cardcom`, `check:paypal`, `check:morning`, `check:dhl`.

**First run:** `npm ci && npm run env:init && npm run db:setup && npm run db:reset && npm run dev`.

**Done means**
1. **Tier A complete.** Tier B done or listed in the PR; P1 listed.
2. `npm run verify:all` is green on a fresh `db:reset` (Node 26.7).
3. The Cardcom live contract has passed and its fixtures are recorded. A hosted payment either completed or is documented as blocked by the test card.
4. The PayPal, Morning and DHL checks skip cleanly, or pass if credentials were supplied.
5. The agent-verifiable QA items are ticked; the user items are listed.
6. `check:secrets` is clean over the full history.
7. README, docs and `.env.example` are complete.
8. The PR is open from `feat/gallery-v1` into `main`.

---

## 11. Git and deliverables

### 11.1 Steps
`GH_TOKEN` comes from the user's shell profile, or is passed per command. It is never written to disk, never echoed and never committed. **The global git config is not modified** (`gh auth setup-git` is not run).
```bash
gh auth status                                   # uses GH_TOKEN from the environment
# M0 on unborn main: README.md (title, paragraph, "work in progress – see the open PR", no-secrets policy) + .gitignore (§7)
git add README.md .gitignore
git commit -m "chore: initial commit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin main
git switch -c feat/gallery-v1
# M1/M2 commits; tag contracts-v1 (local only); ws/* worktrees rebased + ff-merged in M4
npm run check:secrets && git log -p --format= | node --import tsx scripts/check-secrets.ts --stdin
git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin feat/gallery-v1
gh pr create --base main --head feat/gallery-v1 \
  --title "Geula Gallery v1: bilingual originals store with payments, tax documents, shipping and compliance flows" \
  --body-file "$SCRATCH/pr-body.md"
```

**Rules**
- Every commit message ends with the trailer.
- Never add `.env*`, `.data/` or reports.

**CI (P1)**
- Check the token with `gh api -i user | grep -i x-oauth-scopes`.
- No header (for example a fine-grained PAT), or no `workflow` scope → treat it as unknown, put the YAML in `docs/ci.example.yml`, and say so in the PR.
- Only with a confirmed scope, add `.github/workflows/ci.yml` (Node 24, a postgres:18 service, `verify`).

**Repository settings:** ask the user before enabling Dependabot security updates and secret-scanning push protection (`gh api -X PUT repos/Ofek-Israeli/geula_gallery/vulnerability-alerts`, `…/automated-security-fixes`). Otherwise list them as manual steps.

### 11.2 Commit granularity (Conventional Commits; each passes lint and typecheck)
1. `chore: scaffold Next.js 16.3.8 with pinned dependencies and scripts`
2. `chore: tooling – biome, vitest, playwright, dependabot, secrets scan`
3. `feat(db): schema, constraints, partial indexes and initial migration`
4. `feat(i18n): he/en routing, RTL root layout, fonts and design tokens`
5. `feat(ui): accessible primitives, header/footer with cancellation link, demo banner`
6. `feat(auth): Better Auth admin login, rate limiting, TOTP and per-page guards`
7. `feat(core): storage, upload purposes, image ingest, outbox, email core, cron and contracts`
8. `chore(api): generated provider OpenAPI types and adapter stubs`
9. `feat(demo): AIC demo images, manifest and catalog seed`
10. `feat(checkout): reservation, quote binding, mock provider and finalization slice`
11. `feat(payments): Cardcom LowProfile adapter`
12. `feat(payments): PayPal Orders v2 redirect adapter`
13. `feat(payments): refunds, offline payments, reconciliation and sweeps`
14. `feat(invoicing): tax documents – mock, Morning, gateway`
15. `feat(shipping): table rates, country rules and customs`
16. `feat(shipping): DHL Express adapter with fixtures`
17. `feat(fulfillment): fulfillment flow and tracking`
18. `feat(storefront): works grid, artwork page, lightbox and SEO`
19. `feat(admin): dashboard, artwork editor, inbox, manual orders, settings`
20. `feat(compliance): cancellation flow, disclosure document, deadlines, retention`
21. `test: integration and E2E suites`
22. `docs: README, deploy guide, painter onboarding, architecture, testing`

### 11.3 PR description (`$SCRATCH/pr-body.md`)
- Summary: Tier A status, Tier B status, P1, deferrals.
- Architecture and principles; how to run.
- **Provider matrix:**
  - mock ✓;
  - Cardcom test terminal ✓ (Create + GetLpResult; hosted payment if a test card was available);
  - PayPal and Morning: fixture-tested, waiting for sandbox credentials;
  - DHL: fixtures only, with the spec version used.
- Test report; axe; Cardcom contract output.
- Integrity guarantees and the tests that prove them.
- Security notes.
- The QA checklist (agent items ticked; user items unchecked).
- Deviations (§1.4); open questions (§12).
- Repo-settings steps; the local Postgres `max_connections` change.
- Closing line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### 11.4 Docs
- **`README.md`:**
  - what it is and the stack;
  - prerequisites (Homebrew postgresql@18, `max_connections`); quick start;
  - scripts; provider modes; real vs mocked; env overview (admin login from `.env.local`; cron needs a running server);
  - architecture map; demo credits; "Not yet"; legal disclaimer; security policy.
- **`docs/deploy.md`:**
  1. Vercel **Pro** ($20/month; Hobby forbids payment processing and allows only daily cron); Node 24.x; `fra1`.
  2. Neon via the Marketplace in aws-eu-central-1: pooled `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, build `npm run db:migrate && next build`, `attachDatabasePool`, the 10-branch cap.
  3. Blob: public and private stores.
  4. Resend: DNS, eu-west-1, US account data.
  5. Env matrix; `APP_ENV=production`; `CRON_SECRET`; crons; `RATE_LIMIT_SCALE=1`.
  6. Deployment Protection: Protection Bypass for Automation or a staging domain.
  7. PayPal webhook URL, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`.
  8. Domain and HSTS.
  9. Dependabot; the follow-up Next 16.3.x patch.
  10. WAF and BotID.
  11. Blob client uploads (P1).
  12. Font tracing check: render one PDF after deploy.
  13. **Go-live checklist:**
      - `DEMO_MODE=false`; demo works removed; no mock sales on real works;
      - profile completed; legal approved; rates calibrated; insurance coverage confirmed;
      - DHL types regenerated from the current spec;
      - 2FA enrolled;
      - live Cardcom with ApiPassword (enables refunds and the sweep), PayPal live, Morning production, DHL account;
      - a ₪1 live purchase and refund.
- **`docs/painter-onboarding.md`** (Hebrew first):
  - **Provider questions:**
    - Cardcom: rates, USD terminal, installments, J5, LowProfile lifetime, ApiPassword, documents module, webhook retry behaviour and IPs, wallets enabled and the Bit cap, test cards, refund response codes;
    - PayPal: USD receiving, sandbox app, merchant id;
    - Morning: plan and keys;
    - DHL Israel: art value limit, insurance and Shipment Value Protection, WY, export declaration and power of attorney, osek-patur eligibility, voiding labels, DDP;
    - Resend.
  - The accountant and lawyer checklists.
  - Settings walkthrough.
  - How-tos, including confirming an UNKNOWN or FAILED refund in the Cardcom or PayPal dashboard.
  - Runbook: stuck payment, deferred payment, manual refund, LABEL_UNKNOWN, tax doc UNKNOWN, DEAD jobs, unmatched Cardcom transaction, secret leak.
- **`docs/architecture.md`:** layers, state machines (mermaid), the failure table, spike results.
- **`docs/testing.md`:** commands and the QA checklist.
- **`.env.example`:** every variable, with placeholders and comments (derived URLs left unset).

---

## 12. Risks, open questions and deferred decisions

### 12.1 Technical risks
| Risk | Mitigation |
|---|---|
| Next 16.3.8 has two critical/high fixes pending upstream | Exact pins; Dependabot; upgrade the day the patch ships |
| Cardcom unknowns: unpaid code, webhook format and retry behaviour, localhost WebHookUrl, no LowProfile TTL, test cards, USD, refund error codes | Unknown → pending; 72 h watch; 30-day tail poll; live ListTransactions sweep; 500 → retry plus replay; non-zero refund → FAILED, counted in the cap until confirmed; live fixtures today |
| ApiPassword missing on the test terminal (refunds, sweep, gateway documents) | MANUAL_REQUIRED path; fixtures; live-testable only with the painter's terminal |
| PayPal: guest-card eligibility, PENDING captures, local webhooks | Redirect flow; never ship before COMPLETED; review handling; re-entrant capture; reconcile |
| Morning: paid plan; no idempotency key; export vatType and patur refunds unconfirmed | Marker search; NEEDS_MANUAL; accountant |
| DHL: no account; spec version; no idempotency or cancel; art caps | Try 3.3.2 first; `satisfies` contracts; api-mock; LABEL_UNKNOWN; caps in settings; regeneration as a go-live blocker |
| react-pdf Hebrew; react-email in RSC; font tracing on Vercel | M1 spikes; HTML-first disclosure (PDF in Tier B); `outputFileTracingIncludes` + start smoke test |
| Dynamic rendering cost | Fine for a gallery; co-located in Frankfurt |
| Node 26 locally vs 24 on Vercel | Avoid Node-26-only APIs; normalise bidi characters; CI on Node 24 (P1) |
| Placeholder rates or insurance mislead buyers | "Uncalibrated" banner; "insured" shown only when configured; go-live blockers |
| Public repo leak | DB-only profile; env-only credentials; hashed scanner; history scan; push protection; rotation runbook. Generated third-party types carry a small licensing uncertainty: if it matters, gitignore them and generate in CI. |
| Session scope; parallel agents on one machine | Tier A/B cut line; vertical slice first; frozen contracts; ≤ 4 concurrent agents; per-worktree DBs, ports and dist dirs; `max_connections` 200 |
| Workflow-scope push rejection | Unknown scope defaults to `docs/ci.example.yml` |
| Stale-quote or deferred payments refunded or delayed | Requote refused while in flight; payment refused during review; deferral re-evaluated every 15 min; alerts |

### 12.2 Painter decisions
- Legal and trade name, and ID display on documents.
- A business address for publication and returns.
- Phones (WhatsApp).
- Prices and USD prices; installments.
- Offers on or off, and the threshold.
- Hold length; pickup and delivery details.
- Rollable works; framing and glazing.
- Insurance policy (DHL or third-party) and coverage confirmation.
- Shipping calibration; EU and UK toggles.
- Fee policy; the conversation default for offers.
- When to replace the demo images.

### 12.3 Accountant
- Osek patur vs murshe (2026 ceiling ₪122,833; a few sales can cross it).
- Document types 400 / 320 / 330, and how a patur documents a refund.
- **Whether receipts and credit notes are needed for payments refunded as lost, duplicate or stale-quote** (default on; setting `receiptForRefundedPayments`).
- One document system (Morning) vs Cardcom gateway documents; PayPal receipts.
- Zero-rated exports: vatType, export declaration evidence above USD 200 and its timing, pricing.
- USD in ILS books.
- Allocation numbers: only for murshe tax invoices above ₪5,000 before VAT, to VAT-registered business buyers (since 2026-06-01). That is why the optional company and VAT ID fields exist.
- s.18B; commercial invoice vs tax document numbering; 7-year retention.

### 12.4 Lawyer
- **Texts:** final terms, returns, shipping, privacy and accessibility texts; disclosure format (HTML and email body vs a PDF attachment, plus the printed copy).
- **Cancellation:**
  - whether step 1 of the online form counts as notice;
  - **the single-form design**: name plus ID/passport *or* order number, email optional; the EU two-step acknowledgement;
  - whether a refund may wait for the returned work; who pays return shipping;
  - the fee base and its USD conversion;
  - **whether a pre-purchase inquiry or chat counts as a "conversation"** (default: yes, auto-detected), and the default of granting 4 months when eligibility is declared;
  - shipping after a pending cancellation notice (blocked by default);
  - rejection templates; s.2(b2) wording.
- **Pricing:** foreign-currency display (s.17G(a)(1)); Visa merchant-disclosure details; wording of "insured" claims.
- **Cross-border and data:** GPSR, EU targeting and the model form; UK low-value consignments; the deny list (Iraq, Yemen?); ID-number display (excluded from legal pages and footer) and the business address; processors and US transfers; retention.
- **Rights:** copyright and moral-rights clauses; DHL tracking-data consent; AIC demo use.

### 12.5 Deferred decisions and their triggers
| Decision | Trigger |
|---|---|
| Cache Components | performance need |
| Cardcom J5 authorise-then-capture | Cardcom confirms the hold duration |
| PayPal JS SDK / Cardcom iframe | UX data |
| EUR and EU targeting | GPSR answer |
| Newsletter / notify me | consent machinery decided |
| DHL live rates, landed cost, pickup UI | DHL onboarding |
| DHL Unified Tracking API | MyDHL tracking proves insufficient |
| Domestic courier APIs | volume |
| Other PSPs / Airwallex | quotes |
| Multi-item cart | demand |
| Offers (if cut to Tier B) | Tier A green |

### Critical Files for Implementation
- src/server/db/schema/commerce.ts (with catalog.ts): sales and winner partial indexes, quote_version binding, reservation CHECKs, refund two-phase states
- src/server/payments/finalize.ts (with capture.ts, apply.ts, refunds.ts, webhook route): the single state-changing payment path, re-entrant capture, deferral, stale-quote and refund protocols
- src/server/checkout/reservations.ts (with start.ts, requote.ts): lock-before-insert reservation, in-flight-aware predicates, anti-hoarding under advisory locks
- src/server/next/guards.ts (with src/server/auth/options.ts): requireAdmin/AdminContext on every admin page and print route, 2FA enrolment without loops
- src/server/cancellations/service.ts (with src/lib/deadlines.ts): never-blocking cancellation intake, conversation detection, refund deadline from the notice, COMPLETED-order cancellations
