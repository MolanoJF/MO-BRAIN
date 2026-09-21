---
description: Rebuild the dev stack after a change — console-only fast path by default, --full to rebuild the image
argument-hint: [--full]
allowed-tools: Bash(bash scripts/redeploy.sh:*), Bash(docker compose:*), Bash(docker:*), Read, Grep
---

Redeploy the local dev stack by running `scripts/redeploy.sh $ARGUMENTS`.

That script is the single source of truth for how this stack is redeployed — do
not hand-roll `docker compose` incantations, and do not "helpfully" add steps it
deliberately leaves out. Read `scripts/redeploy.sh` if you need to know why it
does something.

## Running it

- No arguments: the console lane. Takes a few seconds. Use a normal timeout.
- `--full`: rebuilds the control-plane image. **Minutes.** Pass a 600000 ms
  timeout, or run it in the background and report when it finishes.

Pick the lane from what actually changed, and say which one you picked and why:

| Changed | Lane |
|---|---|
| `src/console/**` only (UI, styles, client routing) | default |
| `src/control/**`, `src/ops/**`, `src/scheduler/**` | `--full` |
| `package.json`, `bun.lock`, `vite.config.ts`, `docker/**`, `compose/**` | `--full` |

If the user passed `--full` explicitly, honour it — never silently downgrade to
the fast lane because it would be quicker.

## Reporting the result

The script already verifies its own work: the console lane compares what the
control plane actually **serves** against what was just built, and refuses if
they differ. Report what it printed — including the `EPHEMERAL` warning on the
console lane, which matters and must not be dropped from your summary.

On a non-zero exit, the script prints one actionable line and the exit code
says what failed. Do not retry blindly:

| Exit | Meaning | Do |
|---|---|---|
| 10 | Docker daemon unreachable | Tell the user to start Docker Desktop. Do not try to start it yourself. |
| 11 | Host console build failed | Show the build error. This is a code problem — fix it, then redeploy. |
| 12 | control-plane not running | Report it and offer `--full`, or offer to bring the stack up. Ask first. |
| 13 | Image build failed | Show the error. Do not fall back to the console lane — it would mask a real build break. |
| 14 | Served console ≠ what was built | Do not retry the same lane. Report it and offer `--full`. |
| 15 | Control plane never came back healthy | Pull `logs --tail 50 control-plane` and report. Do not restart in a loop. |

Never describe a redeploy as done on a non-zero exit, and never call the
console lane a "build" — it patches a running container and the image still
holds the old console until someone runs `--full`.
