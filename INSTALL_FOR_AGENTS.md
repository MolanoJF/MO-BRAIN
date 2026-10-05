# Installing Mobrain — for coding agents

This file is for an AI coding agent installing Mobrain on a user's behalf (Claude Code, or
similar). If you're a human operator, read [`README.md`](README.md) and
[`docs/runbooks/install.md`](docs/runbooks/install.md) instead — they're the narrative version of
what's below.

Everything here was verified by actually running the install end to end from a fresh clone. Where
the general docs are silent on something that will trip you up, this file says so explicitly.

## 1. Before running anything, confirm with the user (don't guess)

You cannot self-serve these — get them from the person who asked you to install this:

- **A domain, and which TLS mode applies.** By default (`MOBRAIN_TLS_MODE=public`, which is also
  what happens if you don't set it) Caddy always attempts a public Let's Encrypt certificate for
  whatever `DOMAIN` you give it, so you need a domain the user controls with its A/AAAA record
  already pointing at the target host, publicly reachable on 80/443. If the user instead wants
  Mobrain reachable only on an internal network with no public DNS, set `MOBRAIN_TLS_MODE=internal`
  — this is a real, supported mode (`compose/Caddyfile`'s main site substitutes in `tls internal`
  and Caddy issues from its own local CA instead of public ACME), **not** the same thing as just
  setting `PREFLIGHT_SKIP_DNS=1` on its own: that flag alone only skips preflight's DNS check while
  Caddy still tries (and endlessly fails) public ACME, so you'd get a stack that starts but is
  never actually reachable over working HTTPS, and the browser-only first-admin step in §7 can
  never load. Tell the user plainly, before you install with `MOBRAIN_TLS_MODE=internal`, that
  browsers/clients will show an untrusted-certificate warning until they separately distribute and
  trust Caddy's local CA — this is a materially different security posture from a public cert, not
  cosmetic. See `docs/runbooks/install.md`'s "Private-network install (no public DNS)" section.
- **Whether this host will ever run more than one Mobrain instance, or already has one running.**
  See §4 — this matters more than it looks like it should, even though the installer now defends
  against the worst case on its own.
- **Whether to enable the agent runner.** Default to declining (see §3) unless the user explicitly
  asks for it.

## 2. Prerequisites — verify, don't assume

```bash
docker info            # must succeed: Docker Engine 24+ (or Desktop), daemon reachable
docker compose version # must be >= v2.20 (the v2 plugin, not legacy docker-compose v1)
```

The installer (`scripts/install.sh`, `scripts/preflight.sh`) is **bash-only** — there is no
PowerShell equivalent. On Windows, run it from Git Bash or WSL, never from `powershell.exe`
directly. Verified working under Git Bash on Windows 11.

Also required: 4096 MB+ RAM, 20 GB+ free on the Docker data root, ports 80/443 free. Preflight
checks all of this itself and refuses with a specific exit code (§5) if any of it isn't true — you
don't need to check RAM/disk yourself, just Docker, Compose, and the domain.

## 3. The install command — run it non-interactively like this

`scripts/install.sh` has **two interactive prompts**, and both are now avoidable by setting an env
var up front — set both `DOMAIN` and `ENABLE_RUNNER` before running it:

```bash
ENABLE_RUNNER=n DOMAIN=brain.example.com bash scripts/install.sh
```

`ENABLE_RUNNER` works exactly like `DOMAIN`: when it's already set in the environment, the
runner-enable prompt (`read -r -p "...Enable it? [y/N]: "`) is skipped and that value is used
directly instead. Unset, it still fires unconditionally and blocks on stdin — that prompt is **not**
gated on `DOMAIN` being set, so setting `DOMAIN` alone is not enough to avoid it.

Use `ENABLE_RUNNER=n` (decline the runner) unless the user has explicitly asked for the agent
runner enabled — it runs model-written code against the brain using the org's API key,
unsupervised, on a schedule. Verified: `ENABLE_RUNNER=n` leaves `RUNNER_TOKEN` empty and correctly
disables the runner profile, with no prompt fired. If the user does want it on, set
`ENABLE_RUNNER=y` instead and read
[`docs/runbooks/agent-runner.md`](docs/runbooks/agent-runner.md) first — it changes the trust model.
Accepted "on" values match the domain prompt's own case statement (`y`, `Y`, `yes`, `YES`, etc.,
case-insensitive); anything else — including garbage — falls through to **off**, same as the
interactive prompt would.

If you can't set the env var for some reason, the older stdin-piping workaround still works as a
fallback, since an unset `ENABLE_RUNNER` still falls through to the interactive `read`:

```bash
printf 'n\n' | DOMAIN=brain.example.com bash scripts/install.sh
```

For an internal/no-public-DNS install, add `MOBRAIN_TLS_MODE=internal`:

```bash
ENABLE_RUNNER=n MOBRAIN_TLS_MODE=internal DOMAIN=brain.internal.acme-co.lan bash scripts/install.sh
```

If `scripts/install.sh` reports `Refusing to overwrite an existing .env` — **stop and ask the
user**, don't delete it yourself. Deleting `.env` and reinstalling regenerates `ENCRYPTION_KEY`,
which makes every secret already stored in that deployment's database permanently unrecoverable.

## 4. `COMPOSE_PROJECT_NAME` — the installer now defaults this safely, but still pass one explicitly

This used to be a real footgun and is now fixed, but the history matters for judgment calls, so it
stays documented here.

`compose/docker-compose.yml` still hardcodes its Compose project name to `brainstand` when
`COMPOSE_PROJECT_NAME` isn't set — that fallback is now frozen on purpose, because every
pre-existing Mobrain deployment already has volumes named `brainstand_*`, and changing it would
make Compose treat that live data as belonging to a brand-new, empty project on its next `up`. What
changed instead: `scripts/install.sh` no longer leaves `COMPOSE_PROJECT_NAME` unset for a new
install. If you don't pass one, it derives a name deterministically from the checkout's absolute
path (`mobrain-<12 hex chars>`), writes it into the generated `.env`, and **prints the name it
chose** — so two unrelated checkouts on the same host now default to different projects and can't
collide by accident the way they used to.

This was verified to have been actively dangerous before the fix: installing from a second,
unrelated checkout on a host that already had a Mobrain instance running caused Compose to recreate
the *existing* instance's live containers in place and reattach its Postgres volume — but with the
new install's freshly-generated secrets, which didn't match the passwords already in that volume.
Result: the pre-existing instance's `control-plane` and `scheduler` crash-looped on a Postgres auth
failure until manually restored with its own original `.env`. No data was lost (volumes survive
container recreation), but the running instance was knocked out until fixed by hand. `preflight.sh`
now also refuses outright (exit 17) if the resolved project name — derived or explicit — already
has containers on this host, so even a coincidental or deliberate name reuse gets caught before any
secret for the new install is generated.

**Still pass an explicit, unique `COMPOSE_PROJECT_NAME` yourself when you can** — the derived
default is collision-safe, but it's an opaque hash, and a human (or you, six months from now,
reading `docker ps`) will thank you for `mobrain-prod` instead of `mobrain-2e2e744bde35`:

```bash
ENABLE_RUNNER=n DOMAIN=brain.example.com COMPOSE_PROJECT_NAME=mobrain-<something-unique> bash scripts/install.sh
```

Either way (derived or explicit), this does not solve port conflicts (see next paragraph) — it only
prevents container/volume name collisions between separate instances. If you don't know whether
this host already runs Mobrain (or anything else), check first:

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E ':80->|:443->'
```

Caddy binds host ports 80 and 443 directly and they are not configurable in the shipped compose
file — **only one Mobrain instance (or anything else on 80/443) can run per host**, no matter what
`COMPOSE_PROJECT_NAME` you choose. If something already holds those ports, preflight will refuse
cleanly with exit 14 before writing anything (verified) — that's expected, and the fix is a
different host or freeing the port, not a different project name. If preflight instead refuses with
exit 17 (`a Compose project named '<name>' already has containers on this host`), that means the
resolved name — whichever you're using — collides with an existing project's *identity*, even if
its ports happen to be free right now (e.g. it's stopped); pick a different `COMPOSE_PROJECT_NAME`
or confirm with the user that removing the existing project is really what they want.

## 5. If preflight refuses

Preflight exits before generating any secret, so a refusal is always safe to re-run after fixing
the cause:

| Exit | Meaning | Fix |
|---|---|---|
| 10 | Docker missing or daemon unreachable | Install/start Docker; confirm `docker info` works |
| 11 | Compose plugin older than v2.20 | Upgrade the Compose v2 plugin |
| 12 | RAM below 4096 MB | Bigger host |
| 13 | Free disk below 20 GB on the Docker data root | Free space |
| 14 | Port 80 or 443 already in use | Something else (or another instance) holds it — see §4 |
| 15 | `DOMAIN` doesn't resolve to this host | Point its A/AAAA record here, or use `MOBRAIN_TLS_MODE=internal` for a real private-network install (see §1) |
| 16 | Pinned images can't be pulled | Registry unreachable/private (see §6), or build locally |
| 17 | `COMPOSE_PROJECT_NAME` already has containers on this host | Choose a different `COMPOSE_PROJECT_NAME` (see §4), or confirm with the user before removing the existing project |

`SKIP_PREFLIGHT=1` exists but is for the installer's own tests, not for you — don't set it.

## 6. If image pulls fail with "denied"

This was hit and fixed during initial verification of this doc: the images were briefly private on
GHCR, so anonymous pulls were rejected outright. As of this writing they're public and pull
anonymously (and CI now verifies this stays true on every release — see
[`docs/support-policy.md`](docs/support-policy.md)). If you see `denied` on `docker compose ...
pull` again, don't assume it's your environment — verify with a direct anonymous pull first:

```bash
docker pull ghcr.io/molioros/control-plane:1.0.0
```

If that fails for everyone (not just you), it's a registry-visibility regression on the maintainer's
side, not something fixable by changing install flags. The documented fallback if you genuinely
can't pull (air-gapped host, private mirror) is building the three non-`gbrain-base` images locally
from source — see [`docs/runbooks/install.md`](docs/runbooks/install.md#air-gapped-or-registry-less-hosts).
This needs the full source toolchain and was not re-verified end-to-end in this pass.

## 7. After `docker compose up` finishes

Verify before telling the user it's done:

```bash
curl -sk https://$DOMAIN/api/health
```

A healthy fresh install answers `200` with `pin.matches: true`, `components.controlDb: "ok"`,
`components.ops: "ok"`, and `runner.state: "disabled"` (or `"enabled"` if you turned it on).

**This is where your autonomy ends.** Creating the first admin is a browser-only step — open
`https://$DOMAIN`, which serves a bootstrap form with no admin yet. There is no CLI or API path for
this (none was found in the compose files, env template, or any runbook). Hand this back to the
user: tell them the stack is up and healthy, give them the URL, and let them create the account
themselves. Don't attempt to script or fake this step.

If you installed with `MOBRAIN_TLS_MODE=internal`, also tell the user their browser will show an
untrusted-certificate warning at this URL until they trust Caddy's local CA — that's expected, not
a sign something broke.

Also worth telling the user explicitly: **back up `ENCRYPTION_KEY` from `.env` right now**, kept
separately from any database backup. It's not recoverable, and it's the key to every other secret
Mobrain stores.

## Summary: the actual non-interactive recipe

```bash
git clone https://github.com/MoliorOS/MO-BRAIN.git
cd MO-BRAIN
docker ps --format '{{.Ports}}' | grep -E ':80->|:443->'   # confirm nothing else holds 80/443
ENABLE_RUNNER=n DOMAIN=brain.example.com COMPOSE_PROJECT_NAME=mobrain-prod bash scripts/install.sh
curl -sk https://brain.example.com/api/health
```

Then tell the user to open `https://brain.example.com` and create the first admin themselves.
