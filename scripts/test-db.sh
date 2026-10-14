#!/usr/bin/env bash
# Run test/db against a throwaway Postgres in a container named mobrain-test-pg
# on 127.0.0.1:55432. Local only; CI never runs this.
set -euo pipefail

name=mobrain-test-pg
if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 \
    pgvector/pgvector:pg16 >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
fi
export TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
exec bash scripts/test-isolated.sh test/db
