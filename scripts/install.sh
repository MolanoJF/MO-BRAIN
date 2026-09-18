#!/usr/bin/env bash
# Mobrain self-host installer. The compose IS the deployment; this script
# only prompts for a domain, generates secrets, writes .env and brings the
# stack up. The console owns everything after `up`.
set -euo pipefail

# `MOBRAIN_*` are the current names; the legacy `BRAINSTAND_*` spelling keeps
# working for one release, because .env files in the wild already use it.
ENV_PATH="${MOBRAIN_ENV_PATH:-${BRAINSTAND_ENV_PATH:-.env}}"
GBRAIN_VERSION="${GBRAIN_VERSION:-0.50.5.0}"
# G1: the second pinned dependency (D4). Required with no compose default, so
# a deployment that never enables the runner still names a harness version.
HARNESS_VERSION="${HARNESS_VERSION:-2.1.274}"

if [ -e "$ENV_PATH" ]; then
  echo "Refusing to overwrite an existing $ENV_PATH." >&2
  echo "Delete it first if you really mean to reinstall — regenerating ENCRYPTION_KEY" >&2
  echo "makes every stored secret unrecoverable." >&2
  exit 1
fi

# Preflight BEFORE any secret is generated: a host that cannot run the stack
# must not end up holding an ENCRYPTION_KEY it will never use.
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  bash "$(dirname "$0")/preflight.sh" || exit $?
fi

DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  read -r -p "Domain for this brain (e.g. brain.acme-co.com): " DOMAIN || true
fi
if [ -z "$DOMAIN" ]; then
  echo "A domain is required: Caddy obtains a TLS certificate for it." >&2
  exit 2
fi

# D12: the runner is optional, and the question is asked in plain words because
# a yes here hands a container the org's key and nobody watching. Anything but
# an explicit yes (including EOF on a non-interactive install) leaves it off.
ENABLE_RUNNER=""
read -r -p "This container runs model-written code against your brain, using your organization's API key, on a schedule, with nobody watching. Enable it? [y/N]: " ENABLE_RUNNER || true

gen() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48; }

# The token IS the switch: empty means the control plane answers 503
# runner_disabled, and an empty bearer never authenticates.
RUNNER_TOKEN=""
case "$ENABLE_RUNNER" in
  [yY] | [yY][eE][sS]) RUNNER_TOKEN="$(gen)" ;;
esac

umask 077
cat > "$ENV_PATH" <<EOF
DOMAIN=${DOMAIN}
GBRAIN_VERSION=${GBRAIN_VERSION}
HARNESS_VERSION=${HARNESS_VERSION}
# Both names for one release: MOBRAIN_VERSION is current, BRAINSTAND_VERSION
# is the legacy alias older .env files already carry (D3 rename).
MOBRAIN_VERSION=dev
BRAINSTAND_VERSION=dev
WORKER_CONCURRENCY=2

POSTGRES_PASSWORD=$(gen)
OPS_RPC_TOKEN=$(gen)
ENCRYPTION_KEY=$(gen)
BETTER_AUTH_SECRET=$(gen)

# D12: the agent runner is off while this is empty (see .env.example).
RUNNER_TOKEN=${RUNNER_TOKEN}
EOF

if [ -n "$RUNNER_TOKEN" ]; then
  printf '\nCOMPOSE_PROFILES=runner\n' >> "$ENV_PATH"
fi
chmod 600 "$ENV_PATH"

cat <<EOF

Wrote $ENV_PATH (mode 600).

BACK UP ENCRYPTION_KEY SEPARATELY FROM YOUR DATABASE BACKUPS.
Without it, every stored secret is unrecoverable. With both in one place,
a leaked backup is a credential dump.

EOF

if [ -n "$RUNNER_TOKEN" ]; then
  echo "Agent runner enabled: generated RUNNER_TOKEN and added COMPOSE_PROFILES=runner to $ENV_PATH."
fi

if [ "${MOBRAIN_SKIP_UP:-${BRAINSTAND_SKIP_UP:-0}}" = "1" ]; then
  echo "Skipping docker compose up (MOBRAIN_SKIP_UP=1)."
  exit 0
fi

# Project dir is compose/ (first -f), so without --env-file Compose would
# look for compose/.env and miss the secrets we just wrote at $ENV_PATH.
echo "Pulling pinned images (${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-mobrain})…"
if ! docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml pull; then
  echo "Could not pull the pinned Mobrain images." >&2
  echo "On an air-gapped or registry-less host, build them locally instead:" >&2
  echo "  docker compose --env-file \"$ENV_PATH\" -f compose/docker-compose.yml -f compose/docker-compose.build.yml build" >&2
  exit 16
fi
docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml up -d --wait

cat <<EOF

Stack is up. Open https://${DOMAIN} and create your first admin.

Note: https://${DOMAIN}/admin is deliberately NOT routed — gbrain's embedded
admin SPA is a second control plane with god rights over the same brain.
See docs/runbooks/break-glass.md for the recovery path.
EOF
