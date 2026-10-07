#!/usr/bin/env bash
# Mobrain self-host installer. The compose IS the deployment; this script
# only prompts for a domain, generates secrets, writes .env and brings the
# stack up. The console owns everything after `up`.
set -euo pipefail

# `MOBRAIN_*` are the current names; the legacy `BRAINSTAND_*` spelling keeps
# working for one release, because .env files in the wild already use it.
ENV_PATH="${MOBRAIN_ENV_PATH:-${BRAINSTAND_ENV_PATH:-.env}}"
GBRAIN_VERSION="${GBRAIN_VERSION:-0.50.5.0}"
# The product's app version (the published `control-plane` image tag).
# APP_VERSION is the canonical name; the legacy aliases written below name the
# same value so an older .env reader still resolves the released tag (D3 rename).
APP_VERSION="${APP_VERSION:-1.0.0}"
# G1: the second pinned dependency (D4). Required with no compose default, so
# a deployment that never enables the runner still names a harness version.
HARNESS_VERSION="${HARNESS_VERSION:-2.1.274}"

if [ -e "$ENV_PATH" ]; then
  echo "Refusing to overwrite an existing $ENV_PATH." >&2
  echo "Delete it first if you really mean to reinstall — regenerating ENCRYPTION_KEY" >&2
  echo "makes every stored secret unrecoverable." >&2
  exit 1
fi

# compose/docker-compose.yml's own fallback (`${COMPOSE_PROJECT_NAME:-brainstand}`)
# is frozen: every pre-1.0 deployment already has volumes named `brainstand_*`,
# and changing that fallback would make Compose treat them as a different
# project on their next `up`, orphaning live data. So the frozen default stays
# put — instead, every NEW install (this script only ever writes .env once;
# see the refusal above) picks its own name here, derived from the checkout's
# absolute path so two unrelated checkouts on the same host land on different
# projects by default and can never share containers or volumes. This is what
# let a second install silently recreate a first install's live containers in
# place with mismatched secrets — see docs/runbooks/install.md. An explicit
# COMPOSE_PROJECT_NAME always wins, and is exported before preflight runs so
# its port-conflict check reasons about the name this install will actually use.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
if [ -z "$COMPOSE_PROJECT_NAME" ]; then
  COMPOSE_PROJECT_NAME="mobrain-$(pwd -P | sha256sum | cut -c1-12)"
  echo "No COMPOSE_PROJECT_NAME set; using '${COMPOSE_PROJECT_NAME}' (derived from $(pwd -P))." >&2
  echo "Set COMPOSE_PROJECT_NAME explicitly if you need a stable or memorable name." >&2
fi
export COMPOSE_PROJECT_NAME

# The address a local-mode brain answers on. `hostname -I` first (its first
# field is the primary address on every distro that has it), then the source
# address the kernel would pick for an outbound route, then `localhost` — an
# unusual network namespace still gets a working single-machine install rather
# than an empty DOMAIN and a Caddyfile with no site name.
# MOBRAIN_FAKE_LAN_IP is TEST-ONLY, the same convention as preflight's
# PREFLIGHT_FAKE_*: it exists so the local path can be exercised on a host
# without either command, and must never be set in production.
lan_ip() {
  local ip=""
  if [ -n "${MOBRAIN_FAKE_LAN_IP:-}" ]; then printf '%s' "$MOBRAIN_FAKE_LAN_IP"; return; fi
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n1 || true)"
  if [ -z "$ip" ]; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*[[:space:]]src[[:space:]]\{1,\}\([0-9.]\{1,\}\).*/\1/p' | head -n1 || true)"
  fi
  printf '%s' "${ip:-localhost}"
}

# INSTALL_MODE=tailscale: the brain is reachable only on the operator's tailnet.
# `tailscale serve` terminates TLS (a real tailnet certificate, so no browser
# warning) and proxies to Caddy on loopback high ports; Caddy keeps its own
# local-CA certificate behind it. Nothing binds 80/443, so it coexists with
# anything else on the host, including another Tailscale Serve mapping on 443.
# TAILSCALE_HTTPS_PORT is the tailnet-facing port (tailscale serve allows only
# 443, 8443 and 10000); MOBRAIN_LOOPBACK_HTTPS_PORT/_HTTP_PORT are Caddy's.
# MOBRAIN_FAKE_TS_DNSNAME is TEST-ONLY, same convention as MOBRAIN_FAKE_LAN_IP.
ts_dnsname() {
  local name=""
  if [ -n "${MOBRAIN_FAKE_TS_DNSNAME:-}" ]; then printf '%s' "$MOBRAIN_FAKE_TS_DNSNAME"; return; fi
  command -v tailscale >/dev/null 2>&1 || return 0
  if command -v jq >/dev/null 2>&1; then
    name="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    name="$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"])' 2>/dev/null || true)"
  fi
  printf '%s' "${name%.}"
}

# Two installs, one question. A person with a domain answers it; a person who
# just wants their own machine on their own network presses Enter and is never
# asked about DNS, certificates or a cloud account. Same escape hatch as
# ENABLE_RUNNER below: a caller that already knows (CI, an automation script)
# pre-sets DOMAIN or INSTALL_MODE and no prompt fires.
INSTALL_MODE="${INSTALL_MODE:-}"
DOMAIN="${DOMAIN:-}"
if [ -z "$INSTALL_MODE" ] && [ -z "$DOMAIN" ]; then
  read -r -p "Domain for this brain (leave blank to just use this machine on your local network): " DOMAIN || true
fi

# Optional "Continue with Google" sign-in, offered alongside email/password,
# never instead of it. Asked here, while an unset INSTALL_MODE still means
# "interactive": a caller that pre-sets INSTALL_MODE or GOOGLE_CLIENT_ID is
# never prompted, and a blank answer (or EOF) skips it. Empty is a valid,
# supported configuration — the control plane only registers the Google
# provider when both values are set.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
if [ -z "$INSTALL_MODE" ] && [ -z "$GOOGLE_CLIENT_ID" ]; then
  echo "" >&2
  echo "Optional: 'Continue with Google' sign-in, alongside email/password." >&2
  echo "Leave blank to skip — email/password keeps working either way." >&2
  read -r -p "Google OAuth Client ID (leave blank to skip): " GOOGLE_CLIENT_ID || true
  if [ -n "$GOOGLE_CLIENT_ID" ]; then
    read -r -p "Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET || true
  fi
fi
export GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET

if [ -z "$INSTALL_MODE" ]; then
  if [ -n "$DOMAIN" ]; then INSTALL_MODE=domain; else INSTALL_MODE=local; fi
fi

MOBRAIN_TLS_MODE="${MOBRAIN_TLS_MODE:-}"
case "$INSTALL_MODE" in
  domain)
    if [ -z "$DOMAIN" ]; then
      echo "INSTALL_MODE=domain needs a DOMAIN: Caddy obtains a TLS certificate for it." >&2
      echo "Leave DOMAIN unset (or set INSTALL_MODE=local) to install for this machine only." >&2
      exit 2
    fi
    MOBRAIN_TLS_MODE="${MOBRAIN_TLS_MODE:-public}"
    ;;
  local)
    # Public ACME cannot issue for a bare LAN address, so `internal` is not a
    # default here, it is the only coherent answer — and an explicit `public`
    # is a contradiction worth naming rather than silently overriding.
    if [ -n "$MOBRAIN_TLS_MODE" ] && [ "$MOBRAIN_TLS_MODE" != "internal" ]; then
      echo "INSTALL_MODE=local always uses MOBRAIN_TLS_MODE=internal; got '${MOBRAIN_TLS_MODE}'." >&2
      echo "A public certificate authority will not issue for a LAN address. Set a DOMAIN for a public cert." >&2
      exit 2
    fi
    MOBRAIN_TLS_MODE=internal
    DOMAIN="$(lan_ip)"
    echo "No domain given; installing for this machine only, reachable at https://${DOMAIN} on your network." >&2
    ;;
  tailscale)
    if [ -n "$MOBRAIN_TLS_MODE" ] && [ "$MOBRAIN_TLS_MODE" != "internal" ]; then
      echo "INSTALL_MODE=tailscale always uses MOBRAIN_TLS_MODE=internal; got '${MOBRAIN_TLS_MODE}'." >&2
      exit 2
    fi
    MOBRAIN_TLS_MODE=internal
    TAILSCALE_HTTPS_PORT="${TAILSCALE_HTTPS_PORT:-443}"
    case "$TAILSCALE_HTTPS_PORT" in
      443 | 8443 | 10000) ;;
      *) echo "TAILSCALE_HTTPS_PORT must be 443, 8443 or 10000 (the ports tailscale serve allows), got '${TAILSCALE_HTTPS_PORT}'." >&2; exit 2 ;;
    esac
    MOBRAIN_BIND_ADDR=127.0.0.1
    MOBRAIN_HTTPS_PORT="${MOBRAIN_LOOPBACK_HTTPS_PORT:-18443}"
    MOBRAIN_HTTP_PORT="${MOBRAIN_LOOPBACK_HTTP_PORT:-18080}"
    DOMAIN="${DOMAIN:-$(ts_dnsname)}"
    if [ -z "$DOMAIN" ]; then
      echo "INSTALL_MODE=tailscale could not read this machine's tailnet name. Is Tailscale installed and logged in (tailscale status)?" >&2
      echo "Or set DOMAIN to this machine's MagicDNS name (e.g. host.tailnet-name.ts.net)." >&2
      exit 2
    fi
    MOBRAIN_PUBLIC_URL="https://${DOMAIN}"
    [ "$TAILSCALE_HTTPS_PORT" = "443" ] || MOBRAIN_PUBLIC_URL="${MOBRAIN_PUBLIC_URL}:${TAILSCALE_HTTPS_PORT}"
    echo "Installing for your tailnet only, reachable at ${MOBRAIN_PUBLIC_URL}." >&2
    ;;
  *)
    echo "INSTALL_MODE must be 'local', 'domain' or 'tailscale', got '${INSTALL_MODE}'." >&2
    exit 2
    ;;
esac

# public (default in domain mode): Caddy requests a real cert from Let's
# Encrypt, which needs $DOMAIN publicly resolvable and reachable on 80/443.
# internal: Caddy issues from its own local CA instead (compose/Caddyfile's
# `tls internal`). In domain mode it is refused rather than defaulted, because
# silently downgrading to an untrusted cert would be worse than stopping.
# See docs/runbooks/install.md for the trust tradeoff.
case "$MOBRAIN_TLS_MODE" in
  public) CADDY_TLS_DIRECTIVE="" ;;
  internal) CADDY_TLS_DIRECTIVE="tls internal" ;;
  *)
    echo "MOBRAIN_TLS_MODE must be 'public' or 'internal', got '${MOBRAIN_TLS_MODE}'." >&2
    exit 2
    ;;
esac

# Exported so preflight reasons about the install that is actually happening:
# its DNS check needs all three to decide between refusing and skipping.
export INSTALL_MODE DOMAIN MOBRAIN_TLS_MODE
# Preflight checks Caddy's loopback ports and the serve port, not 80/443.
[ "$INSTALL_MODE" != "tailscale" ] || export TAILSCALE_HTTPS_PORT MOBRAIN_HTTPS_PORT MOBRAIN_HTTP_PORT

# Preflight BEFORE any secret is generated: a host that cannot run the stack
# must not end up holding an ENCRYPTION_KEY it will never use. Preflight also
# refuses if COMPOSE_PROJECT_NAME already names a project with containers on
# this host — the exact silent-clobber case above, caught before anything
# for this install is written.
if [ "${SKIP_PREFLIGHT:-0}" != "1" ]; then
  bash "$(dirname "$0")/preflight.sh" || exit $?
fi

# D12: the runner is optional, and the question is asked in plain words because
# a yes here hands a container the org's key and nobody watching. Anything but
# an explicit yes (including EOF on a non-interactive install) leaves it off.
# Same escape hatch as DOMAIN above: a caller that already knows the answer
# (CI, a coding agent, an automation script) sets ENABLE_RUNNER beforehand and
# skips the prompt, instead of having to pipe an answer over stdin.
ENABLE_RUNNER="${ENABLE_RUNNER:-}"
if [ -z "$ENABLE_RUNNER" ]; then
  read -r -p "This container runs model-written code against your brain, using your organization's API key, on a schedule, with nobody watching. Enable it? [y/N]: " ENABLE_RUNNER || true
fi

gen() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-48; }

# The token IS the switch: empty means the control plane answers 503
# runner_disabled, and an empty bearer never authenticates.
RUNNER_TOKEN=""
case "$ENABLE_RUNNER" in
  [yY] | [yY][eE][sS]) RUNNER_TOKEN="$(gen)" ;;
esac

# Tailscale mode only: Caddy on loopback, and the one URL everything else
# (PUBLIC_URL, gbrain --public-url) derives from. Empty in every other mode,
# which leaves the compose defaults (0.0.0.0:80/443, https://${DOMAIN}) alone.
TS_ENV_BLOCK=""
if [ "$INSTALL_MODE" = "tailscale" ]; then
  TS_ENV_BLOCK="# INSTALL_MODE=tailscale: Caddy on loopback only; tailscale serve fronts it.
MOBRAIN_INSTALL_MODE=tailscale
MOBRAIN_PUBLIC_URL=${MOBRAIN_PUBLIC_URL}
MOBRAIN_BIND_ADDR=${MOBRAIN_BIND_ADDR}
MOBRAIN_HTTPS_PORT=${MOBRAIN_HTTPS_PORT}
MOBRAIN_HTTP_PORT=${MOBRAIN_HTTP_PORT}
TAILSCALE_HTTPS_PORT=${TAILSCALE_HTTPS_PORT}"
fi

umask 077
cat > "$ENV_PATH" <<EOF
DOMAIN=${DOMAIN}
# Optional "Continue with Google" sign-in. Both empty (the default) means no
# Google provider and no button; email/password works either way.
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
# Pins this install to its own Compose project (see the comment above this
# script's preflight call) — do not delete this line even if you never
# noticed it get chosen.
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
# MOBRAIN_CADDY_TLS_DIRECTIVE is what compose/Caddyfile actually substitutes
# in; MOBRAIN_TLS_MODE is recorded alongside it only so a human (or this
# script, on re-read) can see which mode produced it without decoding Caddy
# syntax.
MOBRAIN_TLS_MODE=${MOBRAIN_TLS_MODE}
MOBRAIN_CADDY_TLS_DIRECTIVE=${CADDY_TLS_DIRECTIVE}
GBRAIN_VERSION=${GBRAIN_VERSION}
HARNESS_VERSION=${HARNESS_VERSION}
APP_VERSION=${APP_VERSION}
# Both names below are the legacy aliases older .env files already carry (D3
# rename); APP_VERSION above is current, so all three name the released tag.
MOBRAIN_VERSION=${APP_VERSION}
BRAINSTAND_VERSION=${APP_VERSION}
WORKER_CONCURRENCY=2
${TS_ENV_BLOCK}

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
Compose project: ${COMPOSE_PROJECT_NAME}

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
echo "Pulling pinned images (${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molioros})…"
if ! docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml pull; then
  echo "Could not pull the pinned Mobrain images." >&2
  echo "On an air-gapped or registry-less host, build them locally instead:" >&2
  echo "  docker compose --env-file \"$ENV_PATH\" -f compose/docker-compose.yml -f compose/docker-compose.build.yml build" >&2
  exit 16
fi
docker compose --env-file "$ENV_PATH" -f compose/docker-compose.yml up -d --wait

if [ "$INSTALL_MODE" = "tailscale" ]; then
  # Tailnet-only (serve, not funnel). A failure here leaves a healthy stack, so
  # it is a warning with the exact command, not an abort.
  SERVE_CMD="tailscale serve --bg --https=${TAILSCALE_HTTPS_PORT} https+insecure://127.0.0.1:${MOBRAIN_HTTPS_PORT}"
  if [ "${MOBRAIN_SKIP_SERVE:-0}" = "1" ]; then
    echo "Skipping tailscale serve (MOBRAIN_SKIP_SERVE=1). Run: ${SERVE_CMD}"
  elif $SERVE_CMD; then
    echo "tailscale serve is mapping ${MOBRAIN_PUBLIC_URL} -> Caddy (tailnet only)."
  else
    echo "WARNING: could not configure tailscale serve (it may need root or operator rights: sudo tailscale set --operator=\$USER)." >&2
    echo "The stack is up; expose it with: ${SERVE_CMD}" >&2
  fi
  cat <<EOF

Stack is up. Open ${MOBRAIN_PUBLIC_URL} from any device on your tailnet and
create your first admin. The certificate is a real tailnet one, so there is no
browser warning. To stop exposing it: tailscale serve --https=${TAILSCALE_HTTPS_PORT} off
EOF
elif [ "$INSTALL_MODE" = "local" ]; then
  cat <<EOF

Stack is up. Open https://${DOMAIN} from any device on your network and create
your first admin.

Your browser will warn about the certificate the first time — that's expected,
it's a private local CA, not a mistake. See docs/runbooks/install.md.
EOF
else
  cat <<EOF

Stack is up. Open https://${DOMAIN} and create your first admin.
EOF
fi

cat <<EOF

Note: ${MOBRAIN_PUBLIC_URL:-https://${DOMAIN}}/admin is deliberately NOT routed — gbrain's embedded
admin SPA is a second control plane with god rights over the same brain.
See docs/runbooks/break-glass.md for the recovery path.
EOF

# Domain mode only: in local mode the friendlier line above already said this,
# and the stern version would be the second time the user hears it.
if [ "$INSTALL_MODE" = "domain" ] && [ "$MOBRAIN_TLS_MODE" = "internal" ]; then
  cat <<EOF

MOBRAIN_TLS_MODE=internal: Caddy issued a certificate from its own local CA,
not a publicly trusted one. Browsers and API clients will show an untrusted-
certificate warning until you distribute and trust that CA yourself — this is
a real security-posture difference from a public cert, not a cosmetic one.
See docs/runbooks/install.md.
EOF
fi
