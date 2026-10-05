#!/bin/sh
# Proves the gate: no config => stay down; config => run; pause file => stop
# and stay stopped; clearing the pause file => start again.
set -eu
root=$(mktemp -d)
gate=""
cleanup() {
  if [ -n "$gate" ]; then
    kill -TERM "$gate" 2>/dev/null || true
    wait "$gate" 2>/dev/null || true
  fi
  # Kill any fake worker grandchild the crash-restart phase orphaned.
  if [ -f "${GATE_GPID:-}" ]; then
    while read -r p; do
      [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true
    done < "$GATE_GPID"
  fi
  rm -rf "$root"
}
trap cleanup EXIT
mkdir -p "$root/bin" "$root/home/.gbrain"
cat > "$root/bin/gbrain" <<'EOF'
#!/bin/sh
# `worker-child` stands in for the worker `gbrain jobs supervisor` spawns: it
# is NOT the entrypoint's child, so it survives a `kill -TERM` of the
# supervisor unless the entrypoint sweeps orphans while paused.
if [ "${1:-}" = "worker-child" ]; then
  echo "$$" >> "$GATE_GPID"
  trap 'exit 0' TERM INT
  while true; do sleep 1; done
fi
echo "$$" >> "$GATE_PID"
echo "started" >> "$GATE_LOG"
if [ "${1:-}" = "jobs" ]; then
  "$0" worker-child &
fi
trap 'echo "stopped" >> "$GATE_LOG"; exit 0' TERM INT
while true; do sleep 1; done
EOF
chmod 0755 "$root/bin/gbrain"
export PATH="$root/bin:$PATH"
export MOBRAIN_GBRAIN_HOME="$root/home"
export MOBRAIN_GATE_POLL_SECONDS=0.2
export MOBRAIN_QUIESCE_BIN="$PWD/docker/quiesce-gbrain-procs.sh"
export GATE_LOG="$root/log"
export GATE_PID="$root/pid"
export GATE_GPID="$root/gpid"
: > "$GATE_LOG"
: > "$GATE_PID"
: > "$GATE_GPID"

sh docker/gbrain-gated-entrypoint.sh gbrain jobs supervisor --concurrency 2 &
gate=$!

sleep 1
if grep -q started "$GATE_LOG"; then
  echo "gbrain started with no config.json" >&2
  exit 1
fi

echo '{}' > "$root/home/.gbrain/config.json"
echo paused > "$root/home/.mobrain-writers-paused"
sleep 1
if grep -q started "$GATE_LOG"; then
  echo "gbrain started while the pause file existed" >&2
  exit 1
fi

rm -f "$root/home/.mobrain-writers-paused"
i=0
while ! grep -q started "$GATE_LOG"; do
  i=$((i + 1))
  if [ "$i" -gt 20 ]; then
    echo "gbrain did not start after config.json existed and the pause file was gone" >&2
    exit 1
  fi
  sleep 0.2
done

# The supervisor's spawned worker is not the entrypoint's child. Capture the
# direct child and the grandchild, pause, and require BOTH to be gone: while
# the pause file exists the gate must sweep orphans, not just stop its child.
child_pid=$(tail -n 1 "$GATE_PID")
i=0
while [ ! -s "$GATE_GPID" ]; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "the fake supervisor never spawned its worker grandchild" >&2
    exit 1
  fi
  sleep 0.2
done
grand_pid=$(tail -n 1 "$GATE_GPID")

echo paused > "$root/home/.mobrain-writers-paused"
i=0
while ! grep -q stopped "$GATE_LOG"; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "gbrain did not stop after the pause file was created" >&2
    exit 1
  fi
  sleep 0.2
done

if kill -0 "$child_pid" 2>/dev/null; then
  echo "the direct gbrain child survived the pause" >&2
  exit 1
fi
i=0
while kill -0 "$grand_pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 25 ]; then
    echo "the orphaned gbrain worker grandchild survived the pause" >&2
    exit 1
  fi
  sleep 0.2
done

before=$(grep -c started "$GATE_LOG")
sleep 1
after=$(grep -c started "$GATE_LOG")
if [ "$before" != "$after" ]; then
  echo "gbrain restarted while the pause file still existed" >&2
  exit 1
fi

rm -f "$root/home/.mobrain-writers-paused"
i=0
while [ "$(grep -c started "$GATE_LOG")" -lt 2 ]; do
  i=$((i + 1))
  if [ "$i" -gt 20 ]; then
    echo "gbrain did not start again after the pause file was removed" >&2
    exit 1
  fi
  sleep 0.2
done

# Crash-restart: SIGKILL the running gbrain outright, without toggling the
# pause file. The gate must reap the dead child and start a fresh one on its
# own (a zombie would otherwise defeat `kill -0` and never restart).
last_pid=$(tail -n 1 "$GATE_PID")
kill -KILL "$last_pid" 2>/dev/null || true
i=0
while [ "$(grep -c started "$GATE_LOG")" -lt 3 ]; do
  i=$((i + 1))
  if [ "$i" -gt 20 ]; then
    echo "gbrain did not restart after its process was killed" >&2
    exit 1
  fi
  sleep 0.2
done

echo "ok"
