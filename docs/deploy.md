# Deploying Geula Gallery

This guide covers the target production setup: **Vercel Pro, Neon Postgres, Vercel Blob and
Resend**. Nothing has been deployed yet; the deployment itself is deferred (spec §1.3). Steps
that need an account, a credential or a legal sign-off are marked **(owner)**, **(accountant)**
or **(lawyer)**.

> Never commit secrets. All credentials live in the Vercel project's environment variables and
> in your local `.env.local`, which git ignores. The repository is public.

## 1. Vercel project

- **Plan: Vercel Pro** (about $20 per month). Hobby is for non-commercial use only, so it does
  not allow payment processing. It also allows only daily cron jobs, and the shop needs
  `reconcile` and `outbox` every 5 minutes.
- **Runtime: Node 24.x**, from `engines.node` in `package.json`. Development used Node 26.7;
  the code avoids Node-26-only APIs.
- **Region: `fra1`** (Frankfurt), set in `vercel.json`, next to the Neon database.
- **Build command** (Project → Settings → Build): `npm run db:migrate && npm run build`.
  Migrations run before the build against `DATABASE_URL_UNPOOLED`, so a failing migration stops
  the deployment before any new code goes live. Migrations are additive. Never edit a committed
  `drizzle/*.sql` file.
- **Install command:** the default `npm ci`. `.npmrc` keeps versions exact.
- **Crons** are declared in `vercel.json`. Vercel calls `GET /api/cron/<job>` with
  `Authorization: Bearer $CRON_SECRET`, and only on the **production** deployment:

  | Job | Schedule (UTC) | What it does |
  |---|---|---|
  | `reconcile` | every 5 min | expires holds, re-checks open payment attempts, replays unprocessed webhook events |
  | `outbox` | every 5 min | emails, tax documents, PDFs and refund follow-ups (with retries, leases and DEAD) |
  | `tracking` | hourly | carrier tracking; bilingual status emails |
  | `daily` | 05:00 | deadlines and alerts, COMPLETED transitions, the Cardcom tail poll and live sweep, invariants, the go-live digest |
  | `purge` | 02:30 | retention purge (spec §7) |

  Each run is recorded in `cron_runs`. The dashboard warns when a job has not run for 15
  minutes. Every job is idempotent, so a skipped or doubled run is harmless.

## 2. Database: Neon (through the Vercel Marketplace)

- Create the database from the Vercel Marketplace in **aws-eu-central-1** (Frankfurt, next to
  `fra1`). The integration sets the variables on the project.
- `DATABASE_URL` is the **pooled** URL (`-pooler` host), used by the app at runtime.
  `DATABASE_URL_UNPOOLED` is the **direct** URL, used by `db:migrate` during the build.
- In production the app registers its `pg` pool with `attachDatabasePool` from
  `@vercel/functions` (Fluid compute), so idle connections are closed when an instance
  suspends.
- Neon's free and Launch plans allow at most 10 branches. Point Preview deployments at one
  shared preview branch instead of creating one branch per pull request.
- Backups: turn on point-in-time restore for the production branch. Also back up
  `PII_ENCRYPTION_KEY` (§5): without it, the encrypted ID numbers in cancellation notices
  cannot be read.

## 3. Storage: Vercel Blob

- Create **two** stores:
  - a **public** store for web images and OG images;
  - a **private** store for originals, shipping labels, invoices, packing and return photos,
    disclosure PDFs and receipts. These files are served only through signed or admin-checked
    routes.
- Set `STORAGE_DRIVER=blob`, `BLOB_READ_WRITE_TOKEN` (public store),
  `BLOB_PRIVATE_READ_WRITE_TOKEN` (private store), and `NEXT_PUBLIC_BLOB_HOST`, the public
  store's host (for example `abc123.public.blob.vercel-storage.com`). `next/image` and the CSP
  use it. `NEXT_PUBLIC_*` values are inlined at build time, so redeploy after changing it.
- The demo seed supports only the local driver. Production starts from an empty catalog, and the
  painter uploads her works in the admin.
- Admin uploads go through `POST /api/admin/uploads`, which is limited to 4.5 MB per request on
  Vercel. See §11.

## 4. Email: Resend

- Add and verify the sending domain in Resend, in region **eu-west-1** (Ireland), with the SPF,
  DKIM and DMARC DNS records Resend shows. Start with DMARC `p=none` and tighten it later.
- Resend keeps **account data in the US**, even though sending runs in the EU region. The privacy
  policy lists this transfer; the lawyer reviews it.
- Set `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (for example
  `Geula Gallery <studio@your-domain>`) and, optionally, `EMAIL_REPLY_TO`.
- Every send uses an idempotency key (the outbox dedupe key), so a retried job never sends the
  same email twice.

## 5. Environment matrix

`src/server/env.ts` validates everything at boot, including the rules that span several
variables. A misconfiguration fails the deployment instead of misbehaving. Every variable is
listed with a comment in [`.env.example`](../.env.example).

Rules enforced when `APP_ENV=production`:

- `RATE_LIMIT_SCALE=1`;
- `FORM_MIN_AGE_MS` of at least 3000;
- secrets of at least 32 characters;
- with `DEMO_MODE=false`: no `mock` provider, tax documents set to `morning` or `gateway`, a
  carrier other than `mock`, `EMAIL_DRIVER=resend` and `STORAGE_DRIVER=blob`.

`DEMO_MODE=true` forbids every `live` provider mode. `ADMIN_REQUIRE_2FA` is forced on whenever
`APP_URL` is https.

| Variable | Preview (staging, test mode) | Production |
|---|---|---|
| `APP_ENV` | `production`. Policy never depends on `NODE_ENV`. | `production` |
| `APP_URL` | `https://staging.<domain>` | `https://<domain>` |
| `PUBLIC_WEBHOOK_BASE_URL`, `BETTER_AUTH_URL` | unset (derived from `APP_URL`) | unset |
| `APP_SECRET`, `BETTER_AUTH_SECRET` | own random values | at least 32 random bytes each (`openssl rand -base64 48`) |
| `PII_ENCRYPTION_KEY` | own value | base64 of exactly 32 random bytes (`openssl rand -base64 32`). **Back it up; never rotate it casually**: cancellation ID numbers are encrypted with it. |
| `CRON_SECRET`, `MOCK_WEBHOOK_SECRET` | own values | at least 32 characters each |
| `DEMO_MODE` | `true` | `false` for the real shop |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Neon preview branch | Neon main branch (pooled / direct) |
| `ADMIN_REQUIRE_2FA` | forced `true` on https | forced `true` |
| `ADMIN_EMAIL` | painter's email | painter's email |
| `RATE_LIMIT_SCALE` | `1` | `1` (enforced) |
| `FORM_MIN_AGE_MS` | `3000` | at least `3000` (enforced) |
| `PAYMENT_PROVIDERS` | `cardcom,mock` | `cardcom`, plus `paypal` once enabled; never `mock` when `DEMO_MODE=false` |
| `CARDCOM_MODE` | `test` | `live` |
| `CARDCOM_TERMINAL_NUMBER`, `CARDCOM_API_NAME` | test terminal | live terminal |
| `CARDCOM_API_PASSWORD` | optional | **required**: refunds, the daily sweep, gateway documents |
| `CARDCOM_CURRENCIES` | `ILS` | `ILS` or `ILS,USD` (only if the terminal accepts USD) |
| `CARDCOM_3DS`, `CARDCOM_WALLETS` | as the terminal allows | as agreed with Cardcom |
| `PAYPAL_MODE` | `sandbox` | `live` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID` | sandbox app | live app (§7) |
| `TAX_DOCUMENTS_MODE` | `mock` or `morning` | `morning` or `gateway` (accountant's choice) |
| `MORNING_MODE`, `MORNING_CLIENT_ID`, `MORNING_CLIENT_SECRET` | `sandbox` + sandbox keys | `live` + production keys |
| `SHIPPING_CARRIER` | `mock` or `manual` | `dhl` or `manual` |
| `DHL_EXPRESS_MODE`, `DHL_API_KEY`, `DHL_API_SECRET`, `DHL_ACCOUNT_NUMBER` | `test` + test credentials | `live` + account |
| `DHL_PAPERLESS_TRADE` | `false` | `true` only if the account has paperless trade (PLT) |
| `EMAIL_DRIVER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | `resend`, sending to test inboxes | `resend` |
| `STORAGE_DRIVER`, `BLOB_READ_WRITE_TOKEN`, `BLOB_PRIVATE_READ_WRITE_TOKEN`, `NEXT_PUBLIC_BLOB_HOST` | separate preview stores | production stores |
| `CARDCOM_LATE_WATCH_HOURS`, `CARDCOM_TAIL_DAYS` | defaults (72, 30) | defaults |
| `MOCK_PAYMENT_FLOW`, `MOCK_CARRIER_DELIVERY_SECONDS` | defaults | unused |
| `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `E2E_PORT`, `SEED_E2E_USERS`, `NEXT_DIST_DIR`, `LOCAL_STORAGE_DIR`, `ADMIN_PASSWORD`, `AIC_USER_AGENT`, `DHL_OPENAPI_URL`, `*_CONTRACT`, `RECORD_FIXTURES` | unset | unset (local development and test only) |

Scope secrets per environment in Vercel. Never share a production secret with Preview.

## 6. Deployment Protection, webhooks and cron

Vercel Deployment Protection (Vercel Authentication or a password) blocks every request to a
protected URL that has no session, and provider webhooks are such requests.

- **Production** must be reachable by Cardcom, PayPal and Vercel Cron. Keep Deployment
  Protection limited to Preview deployments, which is the "Standard Protection" default.
- **Previews**: either
  - turn on **Protection Bypass for Automation** and register the webhook URLs with the bypass
    secret. Vercel accepts it as the `x-vercel-protection-bypass` header or query parameter.
    PayPal webhooks are configured per app, so a sandbox app can point at a preview URL with
    the query parameter. Cardcom's `WebHookUrl` is built per payment from `APP_URL` (or
    `PUBLIC_WEBHOOK_BASE_URL`), so for Cardcom previews use the next option;
  - or (simpler) use one stable **staging domain** without protection, whose providers are all
    in test or sandbox mode and whose `DEMO_MODE=true`.
- Webhooks are authenticated by the app before any database write: Cardcom with an HMAC in the
  URL, PayPal with the verify postback, the mock provider with an HMAC signature. A forged
  request gets 401 and counts against a per-IP limit.
- Webhooks never decide state on their own. A lost webhook is recovered by the return route,
  the `reconcile` job and the admin's "Recheck payment" button.

## 7. PayPal

- Create a REST app in the PayPal developer dashboard (sandbox first, then live).
- Webhook URL: `https://<domain>/api/payments/paypal/webhook`. Subscribe to
  `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`,
  `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` and
  `CUSTOMER.DISPUTE.CREATED`.
- Copy the webhook's id into `PAYPAL_WEBHOOK_ID`. Without it, every webhook is rejected,
  because verification needs the id. Payments still complete through the return route and
  `reconcile`.
- Set `PAYPAL_MODE=live`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_MERCHANT_ID`.
  The app refuses a payment whose payee merchant id differs; `npm run check:paypal` prints the
  account's merchant id.
- Add `paypal` to `PAYMENT_PROVIDERS`. By default PayPal is offered only for destinations
  outside Israel (a checkout setting).

## 8. Cardcom

- The webhook and return URLs are built per payment
  (`/api/payments/cardcom/{webhook,return}`), so nothing needs to be registered at Cardcom.
- `live` requires `CARDCOM_API_PASSWORD`. Without it, refunds become MANUAL_REQUIRED and the
  daily ListTransactions sweep cannot run.
- Before going live, run `npm run check:cardcom` locally against the **test** terminal you
  received from Cardcom. The public test terminal is refused with ResponseCode 603. Then record
  real fixtures with `-- --record`.

## 9. Domain and HSTS

- Add the domain in Vercel and point DNS as instructed. Set `APP_URL=https://<domain>` and
  redeploy.
- When `APP_ENV=production`, the app sends
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` and
  `upgrade-insecure-requests`. Submit the domain to the HSTS preload list only after a few weeks
  without issues, because removal is slow.
- Every response also carries a strict CSP, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and Referrer and Permissions policies. While `DEMO_MODE=true`, every
  route also sends `X-Robots-Tag: noindex`. Admin pages are `no-store`.

## 10. Dependencies and repository security

- Dependabot (`.github/dependabot.yml`) opens grouped npm updates every week and GitHub Actions
  updates every month. Versions are pinned exactly. Review each PR, run
  `npm run verify:all`, then merge.
- **Pending security patch:** at the time of writing, upstream security fixes for Next 16.3.8
  are pending. Upgrade to the next 16.3.x patch on the day it ships, run `npm run verify:all`
  and deploy.
- In the GitHub repository settings (Settings → Code security), turn on **Dependabot security
  updates** and **secret scanning with push protection** **(owner)**.
- WAF and BotID are not configured (deferred). The rate limits and the honeypot protect the
  forms. If abuse appears, consider Vercel WAF rules for floods on
  `/api/payments/*/webhook` and BotID for checkout.

## 11. Blob client uploads (P1)

Uploads currently go through `POST /api/admin/uploads`, and Vercel limits a request body to
4.5 MB. Large camera photos should move to Blob client uploads (`/api/admin/blob-upload`, P1).
Until then, export photos from the phone at a reduced size.

## 12. Font tracing check

`outputFileTracingIncludes` copies `assets/fonts/**` into every function, because the
disclosure PDF needs the Hebrew fonts at runtime. After the first deployment, place one order
in Preview (mock provider, demo mode). Check that the confirmation email carries
`disclosure-GG-….pdf` and that its Hebrew text renders. If the PDF fails, the email is sent
without it and a `DISCLOSURE_PDF_FAILED` warning appears in Alerts.

## 13. Go-live checklist

The admin dashboard and the `daily` job list the go-live blockers (`src/server/golive.ts`). A
live provider is refused while any blocker exists. The blocker codes are `DEMO_MODE`,
`PROFILE_INCOMPLETE`, `LEGAL_NOT_APPROVED`, `RATES_UNCALIBRATED`, `INSURANCE_UNCONFIRMED`,
`MOCK_SALES_ON_REAL_WORKS`, `DEMO_WORKS_PUBLISHED`, `ADMIN_2FA_MISSING` and `CARDCOM_NOT_LIVE`.

- [ ] `DEMO_MODE=false`. The demo works are removed or unpublished, and no mock sales exist on
      real works.
- [ ] Business profile completed in Settings → Business: legal name, ID or business number,
      addresses, phones **(owner)**.
- [ ] Legal texts approved by the lawyer **(lawyer)**. This is a code change in
      `src/content/legal/versions.ts`: set `LEGAL_TEXTS_APPROVED = true` and replace each
      `-draft` version with the approval date. Orders store the versions the buyer accepted.
- [ ] Tax-document mode and document types confirmed **(accountant)**.
- [ ] Shipping rates calibrated (Settings → Shipping → "Mark calibrated today") and insurance
      coverage confirmed in writing **(owner)**.
- [ ] DHL types regenerated from the current MyDHL spec (`npm run gen:api-types`), then
      `npm run verify`.
- [ ] Every admin enrolled in TOTP 2FA.
- [ ] Cardcom live terminal with **ApiPassword**, which enables refunds and the sweep
      **(owner)**.
- [ ] PayPal live with its webhook id and merchant id; Morning production keys; DHL account
      **(owner)**.
- [ ] Resend domain verified (SPF, DKIM, DMARC).
- [ ] Vercel Pro, `fra1`, crons visible under Project → Settings → Cron Jobs, `CRON_SECRET`
      set.
- [ ] Next.js on the latest 16.3.x security patch.
- [ ] A ₪1 live purchase and its refund, end to end, with the receipt and credit note issued.
- [ ] `PII_ENCRYPTION_KEY` and the Neon restore procedure written down in the owner's password
      manager.
