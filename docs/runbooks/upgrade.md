# Upgrade

Two things version separately: **gbrain** (the pinned upstream brain) and **Mo-brain**
(this repository, whose `gbrain` and `mobrain` images are built on the host).

## gbrain

```bash
bin/mobrain upgrade --gbrain 0.61.0.0
```

It needs the stack host. In order, it:

1. Takes a backup and prints its directory (`bin/mobrain backup`).
2. Writes the new version into `.env` (`GBRAIN_VERSION`).
3. Builds the `gbrain` and `mobrain` images from that version.
4. Stops `autopilot` and `mobrain`, then brings `gbrain` up alone and waits for it.
5. Runs `gbrain apply-migrations --yes --non-interactive` in the `gbrain` container.
6. Reinstalls the schema packs (`mobrain-core`, `mobrain-personal`; the `mobrain-brain`
   layer is created only if missing, never overwritten).
7. Brings the whole stack up with `up -d --wait` and ends with `bin/mobrain status`.

If any step fails it stops and prints these two lines, filled in with the versions and the
backup directory it just took:

```
mobrain: upgrade <from> -> <to> failed. To roll back:
  sed -i 's/^GBRAIN_VERSION=.*/GBRAIN_VERSION=<from>/' <env file> && mobrain restore <backup dir> --yes
```

Do not edit `GBRAIN_VERSION` by hand to upgrade. The backup is the point of the command; a
hand-edited pin has no backup behind it.

### After the upgrade

- Read gbrain's own notes for **every version crossed**, not just the last one:
  `skills/migrations/v<version>.md` in the gbrain checkout (the installed skill bundle
  carries them; `bin/mobrain skills install --dir <dir>` refreshes a person's copy).
- Re-run `bin/mobrain skills install --dir <skills dir>` on every machine that has the
  CLI — the stack host, and each joined member's machine — so every harness gets gbrain's
  pinned skills at the new version alongside Mo-brain's. An agent session that has not
  restarted still has the old MCP registration and the old skills.
- Run `bin/mobrain schema check` (expect `core lock ok`) and `bin/mobrain status`
  (`pin.matches: true`).

## Mo-brain itself

The app images are built on the host, so a code change is:

```bash
git pull                 # or: git merge --ff-only <branch>
bin/mobrain up --build   # rebuild gbrain and mobrain, recreate, wait
bin/mobrain status
```

`bin/mobrain up --build` rebuilds both images and recreates the containers; the `mobrain`
container runs its database migrations on start. Run it on the stack host, from the
checkout. A dev checkout (`COMPOSE_PROJECT_NAME=mobrain-dev`) picks up the dev compose
override automatically.

Local test suite before shipping a change: `bun run test:unit` and `bun run test:db`, both
from the checkout. CI runs only `ci.yml` automatically and `stack.yml` by hand; see
[`ci.md`](ci.md).

## The live host

The live brain runs from a second checkout that only ever fast-forwards — `molior`, a git
worktree of this repository, in its own compose project. It is never edited in place.

1. Finish and commit the change in the dev checkout.
2. Fast-forward the live worktree: `git -C ~/mobrain-molior merge --ff-only <branch>`.
3. Back up first: `bin/mobrain backup` from the live worktree. Do not update without a
   backup.
4. Update: `bin/mobrain up --build` from the live worktree.
5. Confirm health: `bin/mobrain status` must print `ok: true` with `pin.matches: true`.
6. If it broke, roll back the worktree to the last good commit and bring the stack up
   again; restore the pre-update backup only if data was damaged. Ask the owner before
   resetting or restoring.

Never run tests, `down -v`, or `restore` against the live project: it holds real data.
Experiments and restores belong to `mobrain-dev`.
