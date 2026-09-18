# test/unit/publish-images.test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# The production compose file must not be able to build anything.
grep -qE '^\s+build:' compose/docker-compose.yml && fail "D2: production compose still has a build stanza"

# Every service image must be registry-qualified and exactly pinned.
grep -E '^\s+image:' compose/docker-compose.yml | grep -v 'caddy:2' | grep -v 'pgvector/pgvector:pg16' | while read -r line; do
  case "$line" in
    *'${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE'*) : ;;
    *) fail "unqualified image reference: $line" ;;
  esac
  case "$line" in
    *:latest | *:latest-stable | *:main) fail "G1: moving tag in $line" ;;
  esac
done

# The publisher must refuse to push a tag it did not build from an exact pin.
if GBRAIN_VERSION=latest-stable bash scripts/publish-images.sh --dry-run >/dev/null 2>&1; then
  fail "publisher accepted a moving pin"
fi

# A dry run must print all three digests-to-be and push nothing.
out=$(GBRAIN_VERSION=0.50.5.0 HARNESS_VERSION=2.1.274 APP_VERSION=1.0.0 \
      bash scripts/publish-images.sh --dry-run)
for img in gbrain-base control-plane agent-runner; do
  echo "$out" | grep -q "$img" || fail "dry run did not mention $img"
done
echo "$out" | grep -q 'docker push' && fail "dry run would have pushed"
echo PASS
