# Backup and restore

Mo-brain's backup lane is a **host** operation (`scripts/backup.ts`), never an in-container one:
the control-plane image has no Docker CLI and `POST /api/backup` returns `503` when it cannot
invoke Compose. Restore is a host operation too (`scripts/restore.ts`). Both are driven from the
Docker host, over the `compose exec` relay when no ops port is published.

Every number in this runbook was measured during the Task 16 disaster-recovery drill on
2026-09-18 against the live dev stack (`GBRAIN_VERSION=0.50.5.0`), unless a line says otherwise.
The one **policy** number — how often to drill — is marked as such.

---

## What a backup contains

`runBackup(outDir)` writes four components plus a manifest, versioned together as one archive:

| Component | What it is |
|---|---|
| `brain-<stamp>.sql` | `pg_dump` of the `gbrain` database |
| `control-<stamp>.sql` | `pg_dump` of the `control` database |
| `secrets-<stamp>.sql` | `pg_dump` of the control DB's `secrets` table only, so restore can re-materialize credentials without a full control-DB restore |
| `brain-repos-<stamp>.tar` | `/srv/brain-repos` — the Spaces' git repositories, the durable copy of a Space's content |
| `manifest.json` | `id`, `createdAt`, `gbrainVersion`, the four filenames, per-file `sha256`, `quiesced`, `quiesceLane`, `warning` |

The backup also runs `gbrain sources push --all` before it takes the dump, so every Space's git
remote holds the content the archive's repos hold.

### What it deliberately does NOT contain

**`ENCRYPTION_KEY` is not in the archive, and must never be.** The control DB's `secrets` rows are
envelope-encrypted: an AES-256-GCM payload under a wrapped per-row DEK, with the KEK derived by
HKDF from `ENCRYPTION_KEY`. The archive carries the ciphertext; the key lives in the host's `.env`.
**Store `ENCRYPTION_KEY` separately from the archive.** Together they are a credential dump — the
archive alone is useless to an attacker, and the key alone is useless without a row.

The manifest's `warning` says exactly this, and says the other half in the same breath: restoring
to a new domain invalidates every OAuth grant.

The archive also excludes the gbrain **file plane** (`GBRAIN_HOME/.gbrain/config.json`) on purpose:
it holds the provider key and the DB URL in the clear. Restore rebuilds the embedding pin and the
provider key from the control dump (`reMaterializeFilePlane`), so a wipe-and-restore does not leave
the brain resolving a stale shipped default. Measured in this drill: the restore logged
`[restore] re-materialized the gbrain file plane: embedding_model, embedding_dimensions,
openai_api_key`.

---

## The three `quiesced` states

A backup of two databases plus a tar of two volumes taken at three moments is three artifacts that
disagree: a job commits a page to the repo, then writes its row; the tar ran before the commit and
the dump after. `scripts/backup.ts` stops `scheduler` and `gbrain-worker` first and then **proves**
the supervisor is down through the ops lane. `manifest.quiesced` is the result:

| State | What happened | What it means for trusting the archive |
|---|---|---|
| `verified` | The supervisor answered, and it is **not** running. `quiesceLane` names the lane that proved it (`http` or `relay`). | The DBs and the repos were quiesced together. This is the state to archive. |
| `unverified` | The probe **threw** (lane unreachable) or answered nothing. The manifest records no lane. `runBackup` **refuses** to finish unless `--allow-unquiesced` is passed. | The quiesce was never proven. The dump may disagree with the repos. Do not treat it as a recovery point without a reason. |
| `failed` | The supervisor answered and is **still running** after `compose stop`. `runBackup` throws and writes nothing. | There is no archive. Investigate the supervisor before retrying. |

`unverified` is the honesty rule the lane used to violate: the old code's `catch` turned a
connection failure into `quiesced: true`, and on a production host no ops port is published, so the
probe always failed and every production manifest claimed a quiesce nobody checked.

**Which lane proves it.** On a production host nothing but the control plane reaches `:3140` (S2),
so the host-side probe of `OPS_RPC_URL` (which defaults to the container name `gbrain-ops:3140`)
cannot succeed; `defaultOpsCaller()` falls back to the `compose exec` relay and the manifest records
`quiesceLane: "relay"`. On the dev stack the override publishes `3140:3140`, the probe succeeds, and
the lane is `http`. Measured this drill, production shape (base compose file only,
`docker port mobrain-gbrain-ops-1` printed nothing):

```
"quiesced": "verified", "quiesceLane": "relay"      # 10.8 s wall clock
```

Take the backup with:

```bash
docker compose --env-file .env -f compose/docker-compose.yml stop -t 90 scheduler gbrain-worker   # or just run the script
bun run scripts/backup.ts /srv/backups/$(date +%F)
```

`runBackup` performs the stop and the restart itself; the explicit `stop` above is only what the
script does internally, shown so the quiesce window is not a surprise. It restarts
`gbrain-worker` and `scheduler` in a `finally`, so a failed backup still leaves them running.

---

## Restore to the same domain

The common case: the same host, the same `DOMAIN`, an empty or damaged deployment. A same-domain
restore preserves the OAuth grants, because the issuer URL and the redirect URIs do not move.

```bash
export ENCRYPTION_KEY=...            # the key that sealed the archive, held separately
docker compose --env-file .env -f compose/docker-compose.yml up -d --wait
bun run scripts/restore.ts /srv/backups/2026-09-18
```

`runRestore` stops the writers, drops and recreates `gbrain` and `control`, loads the dumps, restores
the repos, re-materializes the file plane, restarts the services, runs
`gbrain apply-migrations --yes --non-interactive`, then `gbrain doctor --json`. Its report carries
`ok` (doctor's exit code alone), the component list, `connectionsNeedingReissue`, and — on the
new-domain branch only — `connectionsInvalidated` and `alertsRaised`.

Measured this drill, same archive, new-domain branch (the stop-to-report path; the same-domain path
is the existing `test/e2e/restore.e2e.test.ts` assertion):

```
"ok": true, "doctorExitCode": 0, "elapsedMs": 21203
```

After a restore, `test/integration/quiesce.test.ts`-style resumes and the restore's own
`stop`/`start` do not remove the dev override's port publication, but a **quiesce** does: the runner
is left **down by design** (D12/D13). Bring it back with the CA export first:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.dev.yml \
  --profile runner up -d caddy-ca-export agent-runner
```

`ENCRYPTION_KEY` is required and is checked before anything is stopped; a restore never begins
without it.

---

## Restore to a new domain

> **Read this consequence before the steps.**
>
> **Restoring to a new `DOMAIN` invalidates every Connection.** OAuth **redirect URIs** and the
> OAuth **issuer URL** are domain-bound: a grant minted when the deployment answered
> `https://old.example` cannot be exchanged or refreshed against `https://new.example`, and a
> client registered with an old-domain redirect URI will not complete a flow on the new domain.
> **Every grant must be re-provisioned.** The knowledge in the archive is intact; the credentials
> are not. This is the case a real disaster produces — a rebuild on a new host, a name change, a
> restored VM with a different public address — and the bulk re-provisioning flow below doubles as
> the DR drill.

The new domain must be set **before** the stack is brought up, because Compose interpolates `DOMAIN`
into Caddy's site address, `gbrain-serve --public-url`, and the control plane's `PUBLIC_URL`:

```bash
# 1. Point the deployment at the new name (edit .env or export DOMAIN).
export DOMAIN=new.example
export ENCRYPTION_KEY=...            # the key that sealed the archive, held separately
export NEW_DOMAIN=new.example        # tells the restore report this is a domain move

# 2. Bring the stack up on the new name, so the new issuer/redirect origin exists.
docker compose --env-file .env -f compose/docker-compose.yml up -d --wait

# 3. Restore the archive into it.
bun run scripts/restore.ts /srv/backups/2026-09-18
```

`runRestore` reports `domainChanged: true` and prints the consequence to stderr:

```
Restored to a NEW DOMAIN: every OAuth grant is invalid — OAuth redirect URIs and issuer URLs
are domain-bound. Re-provision all Connections.
```

It also reports `connectionsNeedingReissue`, the gbrain client ids the restored control DB still
names. Measured this drill: **2** clients needed re-issue, out of **4** Connection rows (2 `active`,
2 already `revoked`). The restore itself finished in **21.2 s** with `doctorExitCode: 0`.

**The new-domain restore invalidates every grant for you (F23, fixed).** After the restored services
are up and `apply-migrations` has run, `runRestore` marks every `connections` row still `active` as
`revoked` (stamping `revoked_at`), retires the live client name so the member can be re-provisioned,
disables each enabled schedule on those Connections with `disabled_reason = "connection_revoked"`,
and raises one **`connection_revoked`** alert per disabled schedule — the member-facing message,
visible on `/schedules` and, as unacknowledged kinds, on `/api/health`. The report's
`connectionsInvalidated` and `alertsRaised` say what actually changed.

Measured on the live stack (the F23 fix): before the restore **2** Connections read `active` and
`/api/health`'s `scheduleAlerts` was `[]`; after it **0** read `active` and **4** `connection_revoked`
alerts were open. `GET /api/connections` — what the console's Connection page reads — now shows
`revoked`, never a working Connection that is not one. A **same-domain** restore is untouched: it
changes no Connection and raises no alert.

---

## The bulk re-provisioning flow

Because a new domain invalidates every grant, the operator's job after the restore is to replace
every Connection, member by member. The restore has already moved every Connection to `revoked` and
raised the alerts, so the job is **re-provision, never revoke again**.

1. **Read the affected set.** `runRestore`'s report names `connectionsNeedingReissue` (the gbrain
   client ids the restored control DB still names) and `connectionsInvalidated` (how many rows it
   actually revoked). Cross-check the console: **Connection** page, every row reads `revoked` after a
   domain move. Measured: 2 rows invalidated in this drill.
2. **Skip the revoke — the restore did it.** It already wrote the control-DB half of the product's
   own revoke: `state = "revoked"`, the retired client name, disabled schedules
   (`disabled_reason = "connection_revoked"`) and a **`connection_revoked`** alert each — the
   member-facing message, visible on `/schedules`. The old gbrain clients are left in place on
   purpose: their issuer/redirect origin is gone, so they cannot mint a working token, and their ids
   stay in the report for this step. The schedules are disabled, not deleted, so a re-grant can
   re-enable them.
3. **Re-provision each member.** Create the Connection again on the console's **Connection** page
   (member, write Space, read Spaces, harness, optional fence), then have the member
   **re-run the harness wiring** against the new domain. A scope change that adds access requires a
   new token; removals apply immediately. The member's old wiring, pointing at the old domain, is
   dead.
4. **Re-check.** `gbrain doctor` on the restored stack (the restore already ran it; exit code `0` in
   this drill), and per-Connection `gbrain mcp verify` on the new domain before telling a member
   they are live.
5. **Re-enable schedules deliberately.** A re-enabled schedule must point at the new Connection and
   the new domain. Do not bulk-enable; confirm each one.

**Re-provision the Anthropic key too.** The archive's `secrets` generation may predate the host's
current Claude Code OAuth refresh (the stored token is a rotating host secret — see
[`agent-runner.md`](./agent-runner.md), "Rotating the Anthropic key"). Re-provision it **after** the
restore cycle, host-side, with the value never printed, or every agent run answers `401
authentication_error`.

---

## How often to drill

**This cadence is a policy choice, not a measurement.** Every other number in this runbook is one
the Task 16 drill produced.

- **After every domain change, in the same change window.** A domain move invalidates every grant;
  the restore path and the bulk re-provisioning are exactly what the move requires, so it is not an
  extra exercise.
- **After every upgrade** (`docs/runbooks/upgrade.md`), because the upgrade gate's rollback and the
  e2e family's own cycles can put back a `secrets` generation.
- **On a regular cadence the operator owns** — the archive is only a backup if a restore has been
  proven to reproduce the brain. An untested restore is not a backup.

The drill itself is the `test/e2e/slice5.e2e.test.ts` C7/C8 legs plus the manual new-domain path
above. C7 proves the archive's quiesce; C8 drives the restore and asserts the Connections are
invalidated. At the time of writing the product does not complete C8 (F23), so the manual flow in
this runbook is the authoritative procedure until the finding is resolved.

---

## See also

- [`upgrade.md`](./upgrade.md) — the upgrade lane and rollback, which restores a volume snapshot.
- [`agent-runner.md`](./agent-runner.md) — the three runner health states and rotating the
  Anthropic key.
- [`break-glass.md`](./break-glass.md) — reaching gbrain when the console is down.
- `test/e2e/restore.e2e.test.ts` — the same-domain restore proof.
- `test/e2e/slice5.e2e.test.ts` — C7 (archive quiesce) and C8 (new-domain invalidation).
