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
QUIESCE=${MOBRAIN_QUIESCE_BIN:-/opt/mobrain/quiesce-gbrain-procs.sh}

child=""

# True (exit 0) only while the child is a live, non-zombie process. A crashed
# gbrain stays a zombie until its parent reaps it, and on Linux `kill -0` on a
# zombie still succeeds -- so a bare `kill -0` would let the gate keep polling
# a corpse and never restart. Read the state from /proc/PID/stat when it is
# available and fall back to the `kill -0` path when /proc is missing.
child_alive() {
  if [ -z "$child" ]; then
    return 1
  fi
  if ! kill -0 "$child" 2>/dev/null; then
    return 1
  fi
  if [ -d /proc ] && [ -r "/proc/$child/stat" ]; then
    state=$(awk '{print $3}' "/proc/$child/stat" 2>/dev/null || true)
    if [ "$state" = "Z" ]; then
      return 1
    fi
  fi
  return 0
}

stop_child() {
  if [ -z "$child" ]; then
    return 0
  fi
  if ! child_alive; then
    wait "$child" 2>/dev/null || true
    child=""
    return 0
  fi
  kill -TERM "$child" 2>/dev/null || true
  i=0
  while child_alive && [ "$i" -lt 50 ]; do
    sleep 1
    i=$((i + 1))
  done
  if child_alive; then
    kill -KILL "$child" 2>/dev/null || true
  fi
  wait "$child" 2>/dev/null || true
  child=""
}

trap 'stop_child; exit 0' TERM INT

# While paused, `gbrain jobs supervisor` may have left an orphaned worker
# process behind (reparented to tini) still holding brain-DB connections --
# `stop_child` only signals the direct child. Sweep every gbrain process on
# each paused poll so the count can actually reach zero (docs/slice-3.5-findings.md F2).
sweep_orphans() {
  if [ -f "$PAUSE" ] && [ -r "$QUIESCE" ]; then
    sh "$QUIESCE" >/dev/null 2>&1 || true
  fi
}

while true; do
  if [ -f "$CONFIG" ] && [ ! -f "$PAUSE" ]; then
    if ! child_alive; then
      if [ -n "$child" ]; then
        wait "$child" 2>/dev/null || true
        child=""
      fi
      "$@" &
      child=$!
    fi
  else
    stop_child
    sweep_orphans
  fi
  sleep "$POLL"
done
