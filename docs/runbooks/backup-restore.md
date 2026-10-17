# Backup and restore

A Mo-brain backup is two database dumps plus the `gbrain-home` volume, taken on the stack
host. It is the thing to reach for before an upgrade, before a destructive experiment, and
when moving the brain to another host.

## Taking a backup

```bash
bin/mobrain backup            # prints the directory it wrote
bin/mobrain backup --prune    # same, then deletes all but the newest 7
```

It needs the stack host (`compose/` plus `.env`). The destination is:

```
${MOBRAIN_BACKUP_DIR:-$HOME/backups/mobrain}/<COMPOSE_PROJECT_NAME>/<UTC timestamp>/
```

`COMPOSE_PROJECT_NAME` is in the path, so two projects on one host never mix, and the
directory name sorts chronologically. What is inside:

| File | Is |
|---|---|
| `gbrain.dump` | `pg_dump -Fc` of the `gbrain` database: pages, chunks, embeddings, the schema pack state |
| `mobrain.dump` | `pg_dump -Fc` of the `mobrain` database: people, invites, grants, clients, collector run history, audit log |
| `gbrain-home.tgz` | the `gbrain-home` volume: schema packs (`mobrain-core`, `mobrain-personal`, `mobrain-brain`), and gbrain's config home |
| `GBRAIN_VERSION` | the gbrain version the backup was taken on |
| `COMMIT` | git `HEAD` of the checkout, or `unknown` |
| `env.sha256` | the SHA-256 of the `.env` at backup time |
| `MANIFEST.sha256` | checksums of the two dumps, the volume tarball, `GBRAIN_VERSION` and `COMMIT` |

The containers keep running while a backup is taken; the dumps are consistent snapshots of
each database.

**`.env` is not in the backup.** It never is. It is written once by `install`, mode `0600`,
and holds `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` and
`OPENAI_API_KEY`. `ENCRYPTION_KEY` seals the stored gbrain client tokens, through the frozen
HKDF domain separator `mobrain-kek-v1`; without the same key, and with a changed separator,
a restored `mobrain` database cannot open its `ui` and `instance` tokens. Keep a copy of
`.env` somewhere that is not the host and not the backup directory, and keep the one that
matches the backup. Never edit or regenerate it after install.

## The daily timer

`bin/mobrain timers install` on the stack host writes a second systemd user unit,
`mobrain-backup.timer`, that runs `bin/mobrain backup --prune` every day at **03:30**. On a
host without a usable systemd user manager it writes the equivalent crontab line instead
(see [`collectors.md`](collectors.md) for the timer mechanics). `--prune` keeps **7** dated
directories per project: a week of dailies, oldest removed first.

## Restoring

```bash
bin/mobrain restore ~/backups/mobrain/mobrain/20261014T033000Z --yes
```

`--yes` is required; without it the command only prints its usage. The restore is
destructive and runs in this order:

1. Checks the directory holds `gbrain.dump`, `mobrain.dump` and `gbrain-home.tgz`; refuses a
   directory that does not look like a Mo-brain backup (exit 17).
2. Checks the backup's `GBRAIN_VERSION` against the `.env` pin. A mismatch stops with exit
   17 unless `--allow-version-change` is passed.
3. Warns if `.env` differs from the one at backup time (`env.sha256`), because stored tokens
   may not open.
4. **Stops** `autopilot`, `gbrain` and `mobrain` (postgres keeps running).
5. Drops and recreates the `gbrain` and `mobrain` databases, then `pg_restore`s each dump
   (`--no-owner`, each database owned by its own role). A few `pg_restore` errors are
   expected and ignored — `must be owner of extension vector`, `... citext`, and
   `permission denied to create event trigger "auto_rls_on_create_table"` — because the
   init scripts own those objects. Any other error aborts the restore.
6. Empties the `gbrain-home` volume and untars the backup into it.
7. `up -d --wait` and `bin/mobrain status`.

Because the services are stopped and the volume wiped, **restore is for a whole-stack
recovery and a host migration, not for pulling one page back**. To recover a single page,
read it out of a dump by hand on a scratch database.

## Test a restore before you need it

Restore on the dev project first, never on the live one:

```bash
bin/mobrain install --owner-email dev@local.test --keyless --project mobrain-dev --port 8788
# take a backup, then break something, then:
bin/mobrain restore <backup dir> --yes
```

For a `mobrain-dev` checkout, `compose/docker-compose.dev.yml` is applied automatically and
`restore` acts on the project named in that checkout's `.env` only — it never guesses. The
name `mobrain-dev` is also one of the two projects whose volumes `bin/mobrain down -v` is
allowed to delete, which is why experiments belong there.

## Moving to another host

1. Copy the backup directory **and** the matching `.env` (mode 0600) to the new host.
2. Install the same release there, or bring up a stack whose `.env` has the same
   `POSTGRES_PASSWORD` and `ENCRYPTION_KEY` and the same `GBRAIN_VERSION`.
3. `bin/mobrain restore <dir> --yes` (add `--allow-version-change` if the new stack runs a
   different gbrain).
4. `bin/mobrain status` and `bin/mobrain schema check` before pointing anyone at it.
