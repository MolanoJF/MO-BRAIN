#!/bin/sh
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/proc/42" "$root/proc/7" "$root/proc/99"
printf 'gbrain\0jobs\0supervisor\0' > "$root/proc/42/cmdline"
printf 'sleep\0infinity\0' > "$root/proc/7/cmdline"
printf '/root/.bun/bin/gbrain\0serve\0--http\0' > "$root/proc/99/cmdline"

PROC_ROOT="$root/proc" QUIESCE_DRY_RUN=1 sh docker/quiesce-gbrain-procs.sh > "$root/out"

grep -qx 'TERM 42' "$root/out"
grep -qx 'TERM 99' "$root/out"
if grep -q 'TERM 7' "$root/out"; then
  echo "sleep was signaled" >&2
  exit 1
fi
echo "ok"
