#!/usr/bin/env bash
# Verifies the three pinned images are PUBLICLY, ANONYMOUSLY pullable from
# GHCR. This is what a fresh install actually does (scripts/install.sh runs
# `docker compose ... pull` with no credentials), and it is exactly the check
# that would have caught the packages being flipped to private: `docker pull`
# from a shell with no `docker login` performed succeeds only for a public
# package. An authenticated pull (e.g. with a GITHUB_TOKEN login) would still
# succeed against a *private* package and prove nothing about what an external
# user's anonymous install sees — so this script must never log in, and it
# logs out of ghcr.io first in case the calling shell already has a stored
# credential (belt-and-braces; callers should also run this from a job that
# never performed `docker login ghcr.io` in the first place).
set -euo pipefail
REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
NS="${IMAGE_NAMESPACE:-molanojf}"

docker logout "$REGISTRY" >/dev/null 2>&1 || true

exact() {  # refuse anything that is not x.y.z[.w] (same rule as publish-images.sh, G1)
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*) : ;;
    *) echo "'$1' is not an exact version" >&2; exit 2 ;;
  esac
}
exact "${GBRAIN_VERSION:?}"; exact "${HARNESS_VERSION:?}"; exact "${APP_VERSION:?}"

failed=0

check() {  # $1 image  $2 tag
  local ref="${REGISTRY}/${NS}/$1:$2"
  echo "--- checking anonymous pull: $ref"
  local out
  if out=$(docker pull "$ref" 2>&1); then
    echo "OK: $ref is publicly pullable"
    return 0
  fi
  echo "$out" >&2
  echo "" >&2
  echo "FAIL: $ref is NOT publicly, anonymously pullable." >&2
  if printf '%s' "$out" | grep -qiE 'denied|unauthorized'; then
    echo "  -> This is the 'denied' error GHCR returns for a PRIVATE package." >&2
    echo "  -> Fix: GitHub -> molanojf's packages -> $1 -> Package settings" >&2
    echo "     -> Danger Zone -> Change visibility -> Public." >&2
  else
    echo "  -> Unexpected failure mode (not a visibility 'denied'); investigate the" >&2
    echo "     docker output above (missing tag, registry outage, etc.)." >&2
  fi
  failed=1
}

check gbrain-base   "$GBRAIN_VERSION"
check control-plane "$APP_VERSION"
check agent-runner  "$HARNESS_VERSION"

if [ "$failed" = 1 ]; then
  echo "" >&2
  echo "One or more pinned images are not publicly pullable. README.md advertises" >&2
  echo "a one-line anonymous install that depends on this working — see" >&2
  echo "docs/support-policy.md." >&2
  exit 1
fi

echo "All three pinned images are publicly, anonymously pullable."
