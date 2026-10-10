#!/bin/sh
# Deploys the working tree to the self-hosted server (docs/deploy.md "Self-hosting"):
#   DEPLOY_HOST=user@host [DEPLOY_KEY=~/.ssh/key] sh scripts/deploy-home.sh
# Copies the sources, then on the server, as the `geula` user with /etc/geula/env: npm ci (with the
# build tools), migrations, next build, and a restart of the geula-web service.
set -eu
: "${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
key="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_geula_server}"
ssh_cmd="ssh -i $key -o IdentitiesOnly=yes"

rsync -az --delete \
  --exclude='/node_modules/' --exclude='/.next*/' --exclude='/.data/' --exclude='/.env*' \
  --exclude='/.git/' --exclude='/.vercel/' --exclude='/test-results/' \
  --exclude='/playwright-report/' --exclude='/coverage/' --exclude='/openapi/' \
  --exclude='*.tsbuildinfo' --exclude='.DS_Store' \
  -e "$ssh_cmd" ./ "$DEPLOY_HOST:geula-src/"

$ssh_cmd "$DEPLOY_HOST" 'set -e
export LC_ALL=en_US.UTF-8
sudo rsync -a --delete --chown=geula:geula ~/geula-src/ /srv/geula/app/ --exclude=/node_modules/ --exclude=/.next/
sudo -u geula bash -c "set -a; . /etc/geula/env; set +a; cd /srv/geula/app \
  && npm ci --include=dev --no-audit --no-fund --loglevel=error \
  && npm run db:migrate && npm run build"
sudo systemctl restart geula-web
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:3000/he && break; sleep 1; done
echo "geula-web: $(systemctl is-active geula-web), /he: $(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/he)"'
