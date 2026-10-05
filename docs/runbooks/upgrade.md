# Upgrade the brain: the one operation, the one way back

An upgrade of this deployment is **one host command**: snapshot in front, image swap in the middle,
`doctor` parity behind. The control plane is the system of record; it never drives the upgrade and it
never touches Docker (S2/D1). This runbook is the operator's side of that split.

Compose commands below use the form this repo uses locally, with the dev override appended:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml <verb>
```

On the VM drop `-f compose/docker-compose.dev.yml`. The `--env-file .env` is **required**: the
`${GBRAIN_VERSION:-0.50.0.0}` fallbacks were removed (D8), so a compose call without it fails loudly
instead of silently starting the old images.

Everything in *How to run one*, *How to roll back* and *Status* below runs **on the host, from the
repo checkout**, not inside a container.

## How to check for an update

The console banner calls `check-update` through the ops RPC (`GET /api/upgrades/available`). It reports
one of three things, and the difference is a trust boundary, not UX:

| status | meaning |
|---|---|
| `available` | `check-update` returned a `latest_version`. It is a **candidate**, with the changelog. |
| `up_to_date` | `check-update` ran and returned `update_available: false`. |
| `unknown` | the check **did not run** (`error: "network_error"` or `"no_releases"`), or the payload was malformed. |

**"unknown" is "could not check", never "up to date".** `check-update` never sets a non-zero exit code —
not even on a network failure (U1) — so the product branches on the body's `.error` and nothing else.
Nothing auto-upgrades (honesty rule 2).

**"Latest" is upstream's master `VERSION`, not a vetted release** (U2). `check-update` reads a file on
the `master` branch (`release_url` names it) and `published_at` is always `''`, because the source has
no timestamp. The banner **offers** a target; **a human selects it** by passing `--to <version>`
explicitly. The product has no release-channel concept and never picks a version for you.

## How to run one

From the host, in the repo root:

```bash
# 1. Dry run: everything preflight checks, nothing touched. No journal, no files.
bun run scripts/upgrade.ts plan --to 0.50.5.0

# 2. The real run. Required: the stack is stopped, the pin is moved and images rebuild.
bun run scripts/upgrade.ts run --to 0.50.5.0 --yes

# 3. Read a run off disk. Works with the control plane down, by design.
bun run scripts/upgrade.ts status --run <runId>
```

- `--to` must be a **four-part exact version**; a moving tag is refused by the CLI itself (G1).
- `--yes` is required for `run`; without it the CLI exits `2` and changes nothing.
- The CLI's exit codes: `0` ok · `1` the upgrade failed · `2` usage · `3` preflight refused, nothing
  touched · `4` the rollback itself failed (break-glass).
- `plan` refuses (exit `3`) on: same version, no playbook entry for a version in `(from, to]`, a
  pending checklist item, Space-repo drift, an unmeasurable/insufficient snapshot volume, or no doctor
  baseline. A refusal leaves **nothing** touched.
- The journal lives under `UPGRADE_DIR` (default `/srv/upgrades`, or the host path compose bind-mounts)
  at **`UPGRADE_DIR/<runId>/journal.ndjson`**. It is the authority while the control plane is down.

`run` may take a while: it stops the stack, snapshots four artifacts, rewrites `.env`, builds four
images, recreates the services, runs `apply-migrations` and `post-upgrade`, applies playbooks, resumes
the writers and runs the `doctor` gate.

## The quiesce order, and why the snapshot is atomic

`run` stops writers in this order, and only this order:

```
scheduler → gbrain-worker → control-plane → gbrain-serve → gbrain-ops
```

Leaving **Postgres as the only live process**. Only then are the four snapshot artifacts taken: both
`pg_dump`s and both volume tars run with **zero writers**, so they cannot disagree with each other.
That ordering *is* the atomicity guarantee (D3); the snapshot's own manifest records the stop order and
the supervisor drain proof.

The measured cost of that window on the 0.50.0.0 → 0.50.5.0 delta (Gate C, recorded in
`docs/slice-3.5-findings.md`):

| Phase | Measured | Span |
|---|---|---|
| Quiesce loop | 3316 ms | first stop (scheduler) → last stop (gbrain-ops) |
| Supervisor-drain window | 764 ms | stop request → drain verdict; deciding event `shutting_down{reason:SIGTERM,exit_code:0}` |
| Snapshot | 2716 ms, 3 840 081 bytes | the four artifacts, `docker-volume` driver |
| Build + swap | 40 310 ms | journal `snapshot_taken` → `swapped` |
| **Total downtime** | **56 274 ms** | quiesce start → `run_completed` (the journal's own definition) |

**The window is dominated by the image build, not the supervisor drain.** L1 measured a clean
supervisor drain at ~1.2 s; the drain is a fraction of the downtime, and the 40 s budget the compose
files carry is not the number to design around.

## Run states (read from the journal)

| State | Meaning |
|---|---|
| `planned` | The run started; nothing touched. |
| `preflight_ok` | Every preflight check passed; the doctor baseline and pre-upgrade digest are on disk. |
| `quiesced` | Writers stopped in order; Postgres alone. |
| `snapshot_taken` | Four artifacts written and checksum-verified. |
| `swapped` | `.env` pin moved, four images built, `gbrain-ops` recreated at the new tag. |
| `migrated` | `apply-migrations` and `post-upgrade` both exited 0. |
| `playbooks_applied` | Deterministic steps ran; checklist items opened; ledger rows journaled. |
| `gated_ok` | Per-check doctor parity holds (D5). |
| `completed` | Done; writers resumed and the stack is healthy. |
| `failed` | Failed **before** the swap; the only mutation was stopped services, and `resume` puts them back. |
| `rolling_back` | Failed **after** the swap; the snapshot is the only way back. |
| `rolled_back` | The rollback restored the pre-upgrade state and verified the pin. |
| `rollback_failed` | The rollback itself failed — break-glass. |

`status` classifies a dead run from the journal alone and tells you whether to resume or roll back; a
run that died before `swapped` can be resumed, a run that died at or after `swapped` requires a
rollback.

## How to roll back

**One command, one operation** (honesty rule 5):

```bash
bun run scripts/upgrade.ts rollback --run <runId>
```

It verifies the snapshot manifest **first** and refuses (`NO_MANIFEST` /
`MANIFEST_VERIFY_FAILED`) if any artifact is missing or its checksum changed; nothing is touched until
that passes. Then it quiesces, restores the four artifacts, moves the pin back, rebuilds the images at
the old pin, recreates the services, resumes them, verifies the running binary, and re-takes the state
digest.

Two things nobody expects, stated plainly:

- **The rollback restores the control database too.** The snapshot's `control-db` artifact is restored
  over the live one, so **anything an admin changed in the console during the upgrade window is lost** —
  members, Connections, schedule edits, and the upgrade run history written by the control plane. The
  journal for the run is on disk and is re-imported by the reconciler; the console changes are not.
- **There are no reverse migrations anywhere upstream** (U8). The pin moves back because the *images*
  move back, never because a binary rewrote itself. The rollback reports
  `method: "snapshot-restore"` and `ranUpstreamDownMigrations: false`; it is snapshot restore or it is
  nothing (D4).

## `awaiting_admin_decision`: the checklist

Some versions ship judgement residue a human must decide — never a step code can execute (G5). They are
opened as `upgrade_checklist_items` in state `pending` and surface as **`awaiting_admin_decision`** on
the version's `playbook_ledger` row.

- A pending item **keeps the banner up and blocks nothing else**. The upgrade is complete; the decision
  is not.
- It **survives control-plane restarts** (it lives in the control database, not in memory).
- An **admin** clears it at `/upgrades` or `POST /api/upgrades/checklist/:itemId/ack`
  (accepts `acknowledged|declined|deferred`; a deferral records the actor and keeps the item `pending`).
  A viewer gets `403`.
- When the last item for a version is acknowledged, that version's ledger row settles to `applied` and
  the decider is recorded. Declining records the actor but does **not** settle the row to `applied`.
- Preflight refuses a new run while any item is still pending — resolve the judgement before stacking
  another upgrade on it.

## When the control plane does not come back

The control plane is stopped for most of the upgrade, so it cannot be the authority on a run that is
swapping it (D2). The authority is the journal:

1. Read `UPGRADE_DIR/<runId>/journal.ndjson` — one JSON object per line, monotonic `seq`. Find the
   last state event.
2. `bun run scripts/upgrade.ts status --run <runId>` gives the same classification.
3. Before `swapped` → resume with `run` (services are restarted; nothing was mutated beyond stopping).
4. At or after `swapped` → `rollback --run <runId>`.
5. When the control plane does return, the reconciler imports the journal into the console
   (`upgrade_runs` / `upgrade_events` / `playbook_ledger` / `upgrade_checklist_items`), idempotent on
   `(runId, seq)`. Nothing is lost because nothing was only in memory.

## Capability drift between pins

Each `run` captures the FROM and TO pins' capability through Task 8's capturer and journals it; the
reconciler imports the captures into `capability_snapshots` when the control plane returns — the same
journal-first path as the ledger. The console's drift panel reads
`GET /api/upgrades/drift?from=<old>&to=<new>`.

- Two captures → the diff `diffCapability` defines:
  `{versionChanged, toolsAdded, toolsRemoved, adaptersAdded, adaptersRemoved, profilesChanged}`.
- Fewer than two → `200 { single_snapshot: true, available: [...] }` — **"nothing to compare yet"**,
  never an empty diff rendered as "no drift".
- The catalog files under `contracts/v<version>/capability.json` are written by
  `bun run capability:capture` and are a separate artifact from these rows.

## Deploying a change to the console or the control plane

The `control-plane` service in `compose/docker-compose.yml` has **no `build:` section** — only an
`image:`. `gbrain-ops` and `control-plane` share one image
(`molioros/control-plane:${APP_VERSION:-1.0.0}`), and `gbrain-ops` is the service that carries
the build context. So:

```bash
# Build the shared image, then recreate every service that runs it.
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  build gbrain-ops
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  up -d --force-recreate control-plane scheduler gbrain-ops
```

`docker compose ... up -d --build control-plane` **silently ships nothing**: there is no build context
on that service, so it recreates the container from the image that is already tagged. If a console page
or a route change did not appear, this is why.

On the dev port, the console's better-auth endpoints require an `Origin` header. Send
`Origin: https://localhost` (or a header matching `PUBLIC_URL`) or better-auth answers
`INVALID_ORIGIN`; this bites `curl` and scripted checks, not a browser on the dev host.

### Member skills backfill (once, for the release that ships member skills)

    docker compose -f compose/docker-compose.yml exec control-plane bun run scripts/widen-member-surfaces.ts

Exit 0: every active Connection now serves `list_skills`/`get_skill`. Exit 1:
the JSON lists each failed Connection. Re-run after fixing (idempotent).

## What NOT to do

- **Never run `gbrain upgrade` or `gbrain self-upgrade` by hand, in a container or on the host.** The
  product owns the upgrade lane: `bun run scripts/upgrade.ts` on the host, with a snapshot in front and
  a one-command rollback behind it. An in-container self-upgrade desynchronizes the image from the
  running binary and leaves nothing to roll back to. `GBRAIN_SELF_UPGRADE_MODE=off` is set for this
  reason, and `scripts/lint-forbidden.ts` fails the build on a moving pin.
- **Never run `gbrain autopilot --install`** in a container. It writes a crontab line; in a container
  that is a silent no-op or a duplicate-scheduler bug. `lint:forbidden` catches it.
- **Never run the executor from inside a container.** The control plane holds no Docker socket or CLI by
  design (S2); a container that could drive the upgrade would break the privilege boundary.
- **Never `docker compose down -v` to "reset" a failed upgrade.** The populated brain is the expensive
  fixture; the snapshot is the way back, not a fresh volume.
- **Never hand-edit `.env`'s `GBRAIN_VERSION` while `run` is in flight**, and never rely on an exported
  `GBRAIN_VERSION` in your shell — `.env` is the single source the pin move rewrites (a stale exported
  value is exactly how a swap can build the new images but recreate the old containers).
- **Never paste a `check-update` failure as "up to date".** `error` is the signal; the exit code is
  always 0 (U1).
- **Never add a `ports:` entry** to make this easier. Caddy is the only host-port publisher.

## Honesty rules an operator must not be surprised by

1. **A drained PID is not a clean drain.** `stop`'s `reason:'drained'` only means the PID vanished
   inside the grace window. The proof is the supervisor's own audit log, window-scoped to the stop:
   a `shutting_down`/`stopped` row with `exit_code: 0` and reason `SIGTERM`/`SIGINT`, cross-checked with
   `jobs supervisor status --json` (`running === false`, no live workers). At 0.50.0.0 a clean stop
   writes `shutting_down` and **no** `stopped` (F1); `stopped` appears on the lock-lost path.
2. **`doctor` exit 0 is not health.** `status: "warnings"` exits 0, and "this binary is behind the
   database schema" is a warn. The gate is **per-check** parity (`checks[]`), never the exit code and
   never `health_score`. There is **no `blockers` key** (L4).
3. **"Latest" is upstream's master `VERSION`, not a vetted release** (U2), and `published_at` is always
   `''`. The banner offers; a human selects.
4. **Nothing auto-upgrades.** `check-update` is deliberately not schedulable, and the self-upgrade mode
   is `off` everywhere.
5. **A pending checklist item keeps the banner up and blocks nothing else.**
6. **A snapshot nobody verified is not a backup.** Every snapshot this lane takes is checksum-verified
   before the swap, and the rollback re-verifies before restoring.
7. **If a gate run aborts mid-leg, the brain can be left fixtured.** The Slice 3.5 exit gate's C2 installs
   a **test-only** migration-collision fixture — recorded `config.version` `143` and `open_loops` reduced to
   a one-column table — and C5 removes it. An abort between the two (failed assertion, timeout, Ctrl-C)
   leaves the brain that way, so the next run's real leg collides on migration 144. The undo path is the
   fixture's own `undoMigrationCollisionFixture` in `test/e2e/fixtures/migration-collision.ts` (the same
   test-only psql lane that applied it); the gate's `afterAll` now calls it automatically as a backstop.
   Before any real upgrade the brain must read `config.version` **149** with the 21-column `open_loops`
   (F9).

## After the upgrade

1. `GET /api/health` → `200` with `pin: { declared, observed, matches }`. `matches: true` means the
   **running binary** agrees with the declared pin (honesty rule 9); `.env` alone is not evidence.
2. `docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
   exec -T gbrain-ops gbrain --version` → the target version.
3. Console `/upgrades`: the run shows `completed`; every expected `playbook_ledger` row is present; any
   `awaiting_admin_decision` item is a decision you still owe (see above).
4. `doctor` parity was asserted by the run itself; if you want a fresh look,
   `GET /api/upgrades` and the run detail carry the parity the gate computed.
5. Note anything you changed by hand during the window — the rollback would forget it.
