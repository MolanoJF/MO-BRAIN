#!/bin/sh
# Non-mutating pre-release check: can this repo's GITHUB_TOKEN push the three
# GHCR images release.yml publishes?
#
# The images live under a PERSONAL namespace (molanojf) while the repo is in
# the MoliorOS org. Whether the org repo's GITHUB_TOKEN (release.yml grants
# `packages: write`) may push to a user-owned package depends on that package's
# "Manage Actions access" setting, which no API exposed to us reports.
#
# The OCI distribution API lets us ask the registry directly: POST to
# /v2/<name>/blobs/uploads/ opens an upload session (HTTP 202 + a `Location`
# header) only when the bearer token holds push rights, and DELETE on that
# Location cancels it. No blob, manifest, or tag is ever created. We never log
# in with docker and never print the token or the Authorization header.
#
# Env: IMAGE_REGISTRY (default ghcr.io), IMAGE_NAMESPACE (default molanojf),
#      GHCR_USER, GHCR_TOKEN (required; never echoed).
set -eu

IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
IMAGE_NAMESPACE="${IMAGE_NAMESPACE:-molanojf}"

: "${GHCR_TOKEN:?GHCR_TOKEN is required (a token with packages:write) and was not set}"
: "${GHCR_USER:?GHCR_USER is required and was not set}"

hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT

denied() {  # $1 name  $2 http code
  printf 'push DENIED %s (HTTP %s)\n' "$1" "$2"
  printf 'Grant MoliorOS/MO-BRAIN write access: GitHub -> molanojf'\''s packages -> %s -> Package settings -> Manage Actions access -> Add repository (Role: Write), or move IMAGE_NAMESPACE to the org.\n' "$1"
}

failed=0

for name in gbrain-base control-plane agent-runner; do
  scope="repository:${IMAGE_NAMESPACE}/${name}:pull,push"
  token=$(curl -fsS -u "${GHCR_USER}:${GHCR_TOKEN}" \
    "https://${IMAGE_REGISTRY}/token?service=${IMAGE_REGISTRY}&scope=${scope}" \
    | jq -r '.token // empty')

  if [ -z "$token" ]; then
    denied "$name" "no bearer token"
    failed=1
    continue
  fi

  code=$(curl -sS -o /dev/null -D "$hdr" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${token}" \
    "https://${IMAGE_REGISTRY}/v2/${IMAGE_NAMESPACE}/${name}/blobs/uploads/") || code="000"

  if [ "$code" = "202" ]; then
    printf 'push OK  %s\n' "$name"
    loc=$(tr -d '\r' < "$hdr" | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | tail -n 1)
    if [ -n "$loc" ]; then
      case "$loc" in
        http://*|https://*) url="$loc" ;;
        /*) url="https://${IMAGE_REGISTRY}${loc}" ;;
        *) url="https://${IMAGE_REGISTRY}/${loc}" ;;
      esac
      curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer ${token}" "$url" || true
    fi
  else
    denied "$name" "$code"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  printf 'release.yml cannot publish until every image allows push from this token.\n' >&2
  exit 1
fi

printf 'All three images allow push from this token.\n'
