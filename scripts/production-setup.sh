#!/bin/sh
# One-off production setup, run by the Vercel production build when SETUP_ON_BUILD=1 (vercel.json).
# Neon's variables are Sensitive: Vercel's builds and functions can read them, but `vercel env pull`
# returns "[SENSITIVE]", so the prod:* scripts cannot reach the database from a laptop.
#   1. Seeds the settings and the painter's catalog (`db:seed --remote`); SEED_BUSINESS_PROFILE, when
#      set, becomes the business profile. The images go to /tmp/prod-seed.
#   2. Uploads those images to the two Blob stores under the same keys (`blob-upload.ts`).
#   3. Creates the admin account when ADMIN_EMAIL and ADMIN_PASSWORD are set.
# Every step is idempotent. Remove SETUP_ON_BUILD, SEED_BUSINESS_PROFILE and ADMIN_PASSWORD after
# the first deployment (docs/deploy.md §0).
set -eu
dir="${SETUP_DIR:-/tmp/prod-seed}"
node --conditions=react-server --import tsx scripts/seed/index.ts --remote --yes --storage-dir "$dir"
node --import tsx scripts/blob-upload.ts --dir "$dir"
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  node --conditions=react-server --import tsx scripts/admin-create.ts
fi
