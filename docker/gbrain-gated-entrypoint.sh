#!/bin/sh
# Start the given gbrain argv only when the brain has a config AND ops has
# not asked writers to stay down. tini is pid 1; this script is the child
# Compose names in `command:`.
set -u
if [ "$#" -lt 1 ]; then
  echo "gbrain-gated-entrypoint: command required" >&2
  exit 64
fi

HOME_DIR=${MOBRAIN_GBRAIN_HOME:-/srv/gbrain-home}
PAUSE="$HOME_DIR/.mobrain-writers-paused"
CONFIG="$HOME_DIR/.gbrain/config.json"
POLL=${MOBRAIN_GATE_POLL_SECONDS:-0.5}

child=""

stop_child() {
  if [ -z "$child" ]; then
    return 0
  fi
  if ! kill -0 "$child" 2>/dev/null; then
    wait "$child" 2>/dev/null || true
    child=""
    return 0
  fi
  kill -TERM "$child" 2>/dev/null || true
  i=0
  while kill -0 "$child" 2>/dev/null && [ "$i" -lt 50 ]; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$child" 2>/dev/null; then
    kill -KILL "$child" 2>/dev/null || true
  fi
  wait "$child" 2>/dev/null || true
  child=""
}

trap 'stop_child; exit 0' TERM INT

while true; do
  if [ -f "$CONFIG" ] && [ ! -f "$PAUSE" ]; then
    if [ -z "$child" ] || ! kill -0 "$child" 2>/dev/null; then
      if [ -n "$child" ]; then
        wait "$child" 2>/dev/null || true
        child=""
      fi
      "$@" &
      child=$!
    fi
  else
    stop_child
  fi
  sleep "$POLL"
done
