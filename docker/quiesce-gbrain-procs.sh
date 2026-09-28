#!/bin/sh
# Signal every gbrain process under PROC_ROOT (default /proc). The slice0
# container's pid 1 is `sleep infinity`; this must not signal it. QUIESCE_DRY_RUN=1
# prints the signals instead of sending them, which is how the host test
# avoids kill(1) against a fake pid.
set -u
PROC_ROOT=${PROC_ROOT:-/proc}
DRY=${QUIESCE_DRY_RUN:-}

is_gbrain() {
  cmd=$(tr '\0' ' ' < "$1" 2>/dev/null || true)
  case "$cmd" in
    gbrain|gbrain\ *|*/gbrain|*/gbrain\ *) return 0 ;;
    *) return 1 ;;
  esac
}

signal_term() {
  if [ "$DRY" = "1" ]; then
    echo "TERM $1"
    return 0
  fi
  kill -TERM "$1" 2>/dev/null || true
}

signal_kill() {
  if [ "$DRY" = "1" ]; then
    return 0
  fi
  kill -KILL "$1" 2>/dev/null || true
}

for dir in "$PROC_ROOT"/[0-9]*; do
  [ -f "$dir/cmdline" ] || continue
  pid=${dir##*/}
  if is_gbrain "$dir/cmdline"; then
    signal_term "$pid"
  fi
done

if [ "$DRY" = "1" ]; then
  exit 0
fi

i=0
while [ "$i" -lt 45 ]; do
  left=0
  for dir in "$PROC_ROOT"/[0-9]*; do
    [ -f "$dir/cmdline" ] || continue
    if is_gbrain "$dir/cmdline"; then
      left=1
    fi
  done
  [ "$left" -eq 0 ] && exit 0
  sleep 1
  i=$((i + 1))
done

for dir in "$PROC_ROOT"/[0-9]*; do
  [ -f "$dir/cmdline" ] || continue
  pid=${dir##*/}
  if is_gbrain "$dir/cmdline"; then
    signal_kill "$pid"
  fi
done
exit 0
