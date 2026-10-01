# Deploying Geula Gallery

This guide covers the target production setup: **Vercel Pro + Neon Postgres + Vercel Blob + Resend**.
Nothing here has been deployed yet (spec §1.3 "Not yet": the actual deployment). Every step that
needs an account, a credential or a legal sign-off is marked **(owner)**.

> Never commit secrets. All credentials live in Vercel project environment variables (and in your
> local `.env.local`, which git ignores).

## 1. Vercel project

- **Plan: Vercel Pro** (about $20/month). Hobby forbids commercial payment processing and only
  allows daily cron jobs; the shop needs `reconcile` and `outbox` every 5 minutes.
- Runtime: **Node 24.x** (`engines.node` in `package.json`); region **`fra1`** (`vercel.json`).
- Build command: `npm run db:migrate && next build` (migrations run against
  `DATABASE_URL_UNPOOLED`).
- Crons are declared in `vercel.json` (`reconcile` and `outbox` every 5 min, `tracking` hourly,
  `daily` 05:00 UTC, `purge` 02:30 UTC). Vercel calls `GET /api/cron/<job>` with
  `Authorization: Bearer $CRON_SECRET`.

## 2. Database: Neon (Vercel Marketplace)

- Create the database from the Vercel Marketplace in **aws-eu-central-1** (Frankfurt, next to
  `fra1`).
- Set `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct; migrations).
- The app uses `attachDatabasePool` from `@vercel/functions` in production.
- Neon's free/launch plans cap branches at 10; preview deployments should share one preview
  branch rather than create one per PR.

## 3. Storage: Vercel Blob

- Create **two** stores: a **public** store (web masters, OG images) and a **private** store
  (originals, labels, invoices, packing and return photos, disclosure PDFs, receipts).
- Set `STORAGE_DRIVER=blob`, `BLOB_READ_WRITE_TOKEN`, `BLOB_PRIVATE_READ_WRITE_TOKEN` and
  `NEXT_PUBLIC_BLOB_HOST` (the public store host, used by `next/image` and the CSP).
- The demo seed only supports the local driver; production starts from an empty catalog.

## 4. Email: Resend

- Verify the sending domain (SPF, DKIM, DMARC DNS records) and choose region **eu-west-1**.
- Resend stores account data in the US — this is listed in the privacy policy.
- Set `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Geula Gallery <studio@…>`),
  optionally `EMAIL_REPLY_TO`.

## 5. Environment matrix

`src/server/env.ts` validates everything at boot; a misconfiguration fails the deployment instead of
misbehaving. Production essentials:

| Variable | Production value |
|---|---|
| `APP_ENV` | `production` (never rely on `NODE_ENV` for policy) |
| `APP_URL` | `https://<domain>` |
| `APP_SECRET`, `BETTER_AUTH_SECRET` | ≥ 32 random bytes each (`openssl rand -base64 48`) |
| `PII_ENCRYPTION_KEY` | base64 of exactly 32 random bytes; **back it up** — cancellation ID numbers are encrypted with it |
| `CRON_SECRET`, `MOCK_WEBHOOK_SECRET` | ≥ 32 characters |
| `DEMO_MODE` | `false` for the real shop |
| `RATE_LIMIT_SCALE` | `1` (enforced) |
| `FORM_MIN_AGE_MS` | ≥ `3000` (enforced) |
| `ADMIN_REQUIRE_2FA` | forced `true` on https |
| `PAYMENT_PROVIDERS` | `cardcom` (and `paypal` once enabled); never `mock` with `DEMO_MODE=false` |
| `TAX_DOCUMENTS_MODE` | `morning` or `gateway` |
| `SHIPPING_CARRIER` | `dhl` or `manual` |

`PUBLIC_WEBHOOK_BASE_URL` and `BETTER_AUTH_URL` are derived from `APP_URL`; set them only when they
differ. See `.env.example` for the full list.

## 6. Deployment Protection

Vercel Deployment Protection blocks provider webhooks and cron on protected URLs. Either use a
**Protection Bypass for Automation** secret for previews, or keep previews on a staging domain
whose providers are in test mode. Production must be reachable by Cardcom, PayPal and Vercel Cron.

## 7. PayPal

- Webhook URL: `https://<domain>/api/payments/paypal/webhook`; subscribe to capture, refund,
  reversal and dispute events.
- Set `PAYPAL_MODE=live`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
  `PAYPAL_MERCHANT_ID` (the app refuses payments whose payee merchant id differs).

## 8. Domain and HSTS

Add the domain in Vercel. HSTS and `upgrade-insecure-requests` are sent only when
`APP_ENV=production`. Submit to the HSTS preload list only after a few weeks without issues.

## 9. Dependencies

Dependabot (`.github/dependabot.yml`) opens weekly grouped npm updates. Next 16.3.8 has upstream
security fixes pending at the time of writing: upgrade to the next 16.3.x patch on the day it
ships, run `npm run verify:all`, deploy.

## 10. WAF and BotID

Not configured (deferred). Rate limits and the honeypot cover the forms; consider Vercel WAF
rules for `/api/payments/*/webhook` floods and BotID for checkout if abuse appears.

## 11. Blob client uploads (P1)

Uploads currently go through `POST /api/admin/uploads` (4.5 MB request limit on Vercel). Large
camera photos should move to Blob client uploads (`/api/admin/blob-upload`, P1).

## 12. Font tracing check

After the first deployment, trigger one order confirmation in a preview (mock provider, demo
mode) and confirm the email carries `disclosure-GG-….pdf` with Hebrew text: this proves
`assets/fonts/**` was traced into the functions (`outputFileTracingIncludes`).

## 13. Go-live checklist

The admin dashboard and the `daily` job list the blockers (`src/server/golive.ts`); live payments
are refused while any exists.

- [ ] `DEMO_MODE=false`; demo works removed (or unpublished); no mock sales on real works.
- [ ] Business profile completed (legal name, ID/business number, addresses, phones) **(owner)**.
- [ ] Legal texts approved by the lawyer; `LEGAL_TEXTS_APPROVED=true` and versions bumped in
      `src/content/legal/versions.ts` **(lawyer)**.
- [ ] Shipping rates calibrated ("Mark calibrated today"); insurance coverage confirmed **(owner)**.
- [ ] DHL types regenerated from the current MyDHL spec (`npm run gen:api-types`).
- [ ] Every admin enrolled in TOTP 2FA.
- [ ] Cardcom live terminal with **ApiPassword** (enables refunds and the daily sweep) **(owner)**.
- [ ] PayPal live, Morning production keys, DHL account **(owner)**.
- [ ] A ₪1 live purchase and its refund, end to end (receipt and credit note issued).
- [ ] `PII_ENCRYPTION_KEY` stored in the owner's password manager.
