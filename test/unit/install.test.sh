#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "--- generates a .env with every required secret"
# PREFLIGHT_SKIP_DNS: this case is about .env generation, not DNS; the host's
# own preflight must still run (unlike SKIP_PREFLIGHT, which would hide it).
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1
for key in DOMAIN POSTGRES_PASSWORD OPS_RPC_TOKEN ENCRYPTION_KEY BETTER_AUTH_SECRET GBRAIN_VERSION; do
  if grep -q "^${key}=.\+" "$work/.env"; then echo "PASS: $key set"; else echo "FAIL: $key missing or empty"; fail=1; fi
done

echo "--- ENCRYPTION_KEY is at least 32 characters"
len=$(grep '^ENCRYPTION_KEY=' "$work/.env" | cut -d= -f2- | tr -d '\n' | wc -c)
if [ "$len" -ge 32 ]; then echo "PASS: length $len"; else echo "FAIL: length $len"; fail=1; fi

echo "--- secrets differ from each other"
if [ "$(grep -c '^OPS_RPC_TOKEN=' "$work/.env")" -eq 1 ] && \
   [ "$(grep '^OPS_RPC_TOKEN=' "$work/.env")" != "$(grep '^ENCRYPTION_KEY=' "$work/.env" | sed s/ENCRYPTION_KEY/OPS_RPC_TOKEN/)" ]; then
  echo "PASS: distinct secrets"
else echo "FAIL: secrets collide"; fail=1; fi

echo "--- MOBRAIN_TLS_MODE=internal writes tls internal into MOBRAIN_CADDY_TLS_DIRECTIVE"
DOMAIN=brain-internal.test MOBRAIN_TLS_MODE=internal MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.internal" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^MOBRAIN_TLS_MODE=internal$' "$work/.env.internal" && grep -q '^MOBRAIN_CADDY_TLS_DIRECTIVE=tls internal$' "$work/.env.internal"; then
  echo "PASS: internal mode written"
else
  echo "FAIL: internal mode not written as expected"; fail=1
fi

echo "--- MOBRAIN_TLS_MODE=internal does not require DOMAIN to resolve"
# No PREFLIGHT_SKIP_DNS here on purpose: MOBRAIN_TLS_MODE=internal alone must
# be enough to satisfy preflight's DNS check for a domain with no public DNS.
if DOMAIN=nx.invalid MOBRAIN_TLS_MODE=internal PREFLIGHT_FAKE_DNS=nxdomain MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.nodns" bash scripts/install.sh >/dev/null 2>&1; then
  echo "PASS: internal mode bypassed the DNS refusal"
else
  echo "FAIL: internal mode still hit the DNS refusal"; fail=1
fi

echo "--- rejects an unrecognized MOBRAIN_TLS_MODE"
if DOMAIN=brain.test MOBRAIN_TLS_MODE=bogus PREFLIGHT_SKIP_DNS=1 MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.bogus" bash scripts/install.sh >/dev/null 2>&1; then
  echo "FAIL: accepted an invalid MOBRAIN_TLS_MODE"; fail=1
else
  echo "PASS: rejected invalid MOBRAIN_TLS_MODE"
fi

echo "--- refuses to clobber an existing .env"
if DOMAIN=brain.test BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1; then
  echo "FAIL: overwrote an existing .env"; fail=1
else echo "PASS: refused to overwrite"; fi

echo "--- refuses to run without DOMAIN"
if BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env2" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: ran without DOMAIN"; fail=1
else echo "PASS: required DOMAIN"; fi

echo "--- ENABLE_RUNNER=n skips the prompt and leaves the runner off"
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 ENABLE_RUNNER=n BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env3" bash scripts/install.sh </dev/null >/dev/null 2>&1
if grep -q '^RUNNER_TOKEN=$' "$work/.env3" && ! grep -q '^COMPOSE_PROFILES=runner$' "$work/.env3"; then
  echo "PASS: runner left off"
else
  echo "FAIL: ENABLE_RUNNER=n did not leave the runner off"; fail=1
fi

echo "--- ENABLE_RUNNER=y skips the prompt and enables the runner"
DOMAIN=brain.test PREFLIGHT_SKIP_DNS=1 ENABLE_RUNNER=y BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env4" bash scripts/install.sh </dev/null >/dev/null 2>&1
if grep -q '^RUNNER_TOKEN=.\+' "$work/.env4" && grep -q '^COMPOSE_PROFILES=runner$' "$work/.env4"; then
  echo "PASS: runner enabled"
else
  echo "FAIL: ENABLE_RUNNER=y did not enable the runner"; fail=1
fi

# Parse the script source — BRAINSTAND_SKIP_UP must not skip this check.
# Without --env-file, Compose loads .env from the project dir of the first -f
# (compose/), so the secrets install.sh just wrote never reach interpolation.
echo "--- compose up argv includes --env-file (parse script; no Docker)"
up_line=$(grep -E 'docker[[:space:]]+compose[[:space:]].*up[[:space:]]+-d[[:space:]]+--wait' scripts/install.sh | head -n1)
if echo "$up_line" | grep -q -- '--env-file'; then
  echo "PASS: up argv includes --env-file"
else
  echo "FAIL: up argv missing --env-file: ${up_line:-<no up line>}"
  fail=1
fi

# Parse the script source the way the --env-file case does, so a runtime
# BRAINSTAND_SKIP_UP=1 cannot hide the ordering. Preflight must run before the
# first `$(gen)`: a host that cannot run the stack must never hold an
# ENCRYPTION_KEY.
echo "--- preflight precedes the first gen() call (parse script; no Docker)"
preflight_line=$(grep -nE 'preflight\.sh' scripts/install.sh | head -n1 | cut -d: -f1)
gen_line=$(grep -nE '\$\(gen\)' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$preflight_line" ] && [ -n "$gen_line" ] && [ "$preflight_line" -lt "$gen_line" ] && \
   grep -q 'SKIP_PREFLIGHT' scripts/install.sh; then
  echo "PASS: preflight (line $preflight_line) precedes first gen() (line $gen_line)"
else
  echo "FAIL: preflight line '${preflight_line:-<none>}' does not precede gen() line '${gen_line:-<none>}'"
  fail=1
fi

# The pull leg must exist and precede `up -d --wait`, and its failure path must
# name the air-gapped build fallback rather than leave a bare manifest unknown.
echo "--- pull leg exists and precedes up (parse script; no Docker)"
pull_line=$(grep -nE 'docker[[:space:]]+compose[[:space:]].*pull' scripts/install.sh | head -n1 | cut -d: -f1)
up_line_num=$(grep -nE 'docker[[:space:]]+compose[[:space:]].*up[[:space:]]+-d[[:space:]]+--wait' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$pull_line" ] && [ -n "$up_line_num" ] && [ "$pull_line" -lt "$up_line_num" ] && \
   grep -q 'docker-compose.build.yml' scripts/install.sh; then
  echo "PASS: pull (line $pull_line) precedes up (line $up_line_num) and names the build fallback"
else
  echo "FAIL: pull line '${pull_line:-<none>}' does not precede up line '${up_line_num:-<none>}'"
  fail=1
fi

exit $fail
