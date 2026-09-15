#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "--- generates a .env with every required secret"
DOMAIN=brain.test BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1
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

echo "--- refuses to clobber an existing .env"
if DOMAIN=brain.test BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env" bash scripts/install.sh >/dev/null 2>&1; then
  echo "FAIL: overwrote an existing .env"; fail=1
else echo "PASS: refused to overwrite"; fi

echo "--- refuses to run without DOMAIN"
if BRAINSTAND_SKIP_UP=1 BRAINSTAND_ENV_PATH="$work/.env2" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: ran without DOMAIN"; fail=1
else echo "PASS: required DOMAIN"; fi

exit $fail
