#!/usr/bin/env bash
# brainstand self-host installer. The compose IS the deployment; this script
# only prompts for a domain, generates secrets, writes .env and brings the
# stack up. The console owns everything after `up`.
set -euo pipefail

ENV_PATH="${BRAINSTAND_ENV_PATH:-.env}"
GBRAIN_VERSION="${GBRAIN_VERSION:-0.50.0.0}"

if [ -e "$ENV_PATH" ]; then
  echo "Refusing to overwrite an existing $ENV_PATH." >&2
  echo "Delete it first if you really mean to reinstall — regenerating ENCRYPTION_KEY" >&2
  echo "makes every stored secret unrecoverable." >&2
  exit 1
fi

DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  read -r -p "Domain for this brain (e.g. brain.acme-co.com): " DOMAIN || true
fi
if [ -z "$DOMAIN" ]; then
  echo "A domain is required: Caddy obtains a TLS certificate for it." >&2
  exit 2
fi

gen() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48; }

umask 077
cat > "$ENV_PATH" <<EOF
DOMAIN=${DOMAIN}
GBRAIN_VERSION=${GBRAIN_VERSION}
BRAINSTAND_VERSION=dev
WORKER_CONCURRENCY=2

POSTGRES_PASSWORD=$(gen)
OPS_RPC_TOKEN=$(gen)
ENCRYPTION_KEY=$(gen)
BETTER_AUTH_SECRET=$(gen)
EOF
chmod 600 "$ENV_PATH"

cat <<EOF

Wrote $ENV_PATH (mode 600).

BACK UP ENCRYPTION_KEY SEPARATELY FROM YOUR DATABASE BACKUPS.
Without it, every stored secret is unrecoverable. With both in one place,
a leaked backup is a credential dump.

EOF

if [ "${BRAINSTAND_SKIP_UP:-0}" = "1" ]; then
  echo "Skipping docker compose up (BRAINSTAND_SKIP_UP=1)."
  exit 0
fi

docker compose -f compose/docker-compose.yml up -d --wait

cat <<EOF

Stack is up. Open https://${DOMAIN} and create your first admin.

Note: https://${DOMAIN}/admin is deliberately NOT routed — gbrain's embedded
admin SPA is a second control plane with god rights over the same brain.
See docs/runbooks/break-glass.md for the recovery path.
EOF
