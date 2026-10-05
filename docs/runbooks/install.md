# Install runbook: first install

Mobrain is a self-hosted Docker Compose stack. This runbook takes you from a clean host to a running console with one admin. It assumes you have a checkout of this repository on the host that will run the stack.

## Before you start

- A host with **Docker Engine 24+** (or Docker Desktop) and the **Compose v2 plugin, v2.20 or newer**, with a reachable daemon.
- **At least 4096 MB of RAM** and **20 GB free on the Docker data root**.
- **Ports 80 and 443 free.** Caddy is the only service that publishes a host port; nothing else does.
- **Either** a `DOMAIN` you control whose A/AAAA record already points at this host (Caddy obtains a real TLS certificate for it), **or** nothing at all — leave the domain blank and Mobrain installs against this host's own LAN address with a private certificate. (A port already held by *this* stack is not a conflict.)

The installer runs `scripts/preflight.sh` before it generates any secret, so a host that cannot run the stack never ends up holding an `ENCRYPTION_KEY` it cannot use.

## The one command

From the repository root:

```bash
bash scripts/install.sh            # local: this machine on your own network
DOMAIN=brain.acme-co.com bash scripts/install.sh   # domain: a public certificate
```

The installer, in order:

1. refuses if an `.env` already exists (delete it deliberately if you mean to reinstall — regenerating `ENCRYPTION_KEY` makes every stored secret unrecoverable);
2. reads `DOMAIN` from the environment, or asks for it — *"Domain for this brain (leave blank to just use this machine on your local network):"*. A blank answer selects **local mode**: the installer detects this host's LAN address (`hostname -I`, then the outbound route's source address, then `localhost`), uses it as `DOMAIN`, and forces `MOBRAIN_TLS_MODE=internal`. A non-blank answer selects **domain mode**, unchanged from previous releases;
3. runs preflight, and exits with the failing check's code if the host cannot run the stack. In domain mode this now includes the DNS check against the domain you just gave it; in local mode the DNS check is skipped and says so;
4. asks the runner question in plain words — *"This container runs model-written code against your brain, using your organization's API key, on a schedule, with nobody watching. Enable it? [y/N]:"* — unless `ENABLE_RUNNER` is already set in the environment, in which case it skips the prompt and uses that value directly. Either way, anything but an explicit yes (`y`/`yes`, case-insensitive — including EOF on a non-interactive install with neither variable set) leaves the runner **off**;
5. generates four independent secrets and writes `.env` at mode `600`;
6. pulls the pinned images from `${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molioros}` and runs `docker compose up -d --wait`.

Preflight still runs before a single secret is generated, so a host that cannot run the stack never ends up holding an `ENCRYPTION_KEY` it cannot use.

### Running it non-interactively

For a fully non-interactive install (CI, a coding agent, an automation script), set both `DOMAIN` and `ENABLE_RUNNER` up front so neither prompt fires:

```bash
ENABLE_RUNNER=n DOMAIN=brain.acme-co.com bash scripts/install.sh
```

For a non-interactive **local** install, set `INSTALL_MODE=local` — it skips the domain prompt without needing a `DOMAIN`:

```bash
INSTALL_MODE=local ENABLE_RUNNER=n bash scripts/install.sh
```

Use `ENABLE_RUNNER=n` unless you specifically want the agent runner on (see [`agent-runner.md`](agent-runner.md) first — it changes the trust model); use `ENABLE_RUNNER=y` to enable it without the prompt.

If you can't set the env var for some reason, piping the answer over stdin still works as a fallback, since an unset `ENABLE_RUNNER` still falls through to the interactive `read`:

```bash
printf 'n\n' | DOMAIN=brain.acme-co.com bash scripts/install.sh
```

To point the installer at a different registry — a mirror, or your own namespace — set the two registry variables explicitly. They default to `ghcr.io` and `molioros` (the product is **Mobrain**; GHCR images publish under the MoliorOS org namespace that owns the release):

```bash
DOMAIN=brain.acme-co.com IMAGE_REGISTRY=ghcr.io IMAGE_NAMESPACE=molioros bash scripts/install.sh
```

Every variable in the generated file is documented in [`.env.example`](../../.env.example).

## Compose project name

`compose/docker-compose.yml` names its Compose project from `COMPOSE_PROJECT_NAME`, and Compose
uses that name to decide which containers and volumes a given `up` owns. If you never set it, the
installer picks one for you and writes it into `.env`: `mobrain-<12 hex chars derived from this
checkout's absolute path>`. It prints the name it chose — it is never silent about this. Running
`scripts/install.sh` again from the *same* checkout path derives the *same* name, so a later
upgrade or reinstall keeps targeting the same containers; a *different* checkout gets a different
name automatically, so two unrelated installs on one host default to separate projects and can
never share containers or volumes.

Set `COMPOSE_PROJECT_NAME` yourself if you want a stable, memorable name instead of the derived
one — an explicit value always wins:

```bash
DOMAIN=brain.acme-co.com COMPOSE_PROJECT_NAME=mobrain-prod bash scripts/install.sh
```

Preflight refuses (exit 17, below) if the resolved name — derived or explicit — already has
containers on this host, whether or not they are running: that is exactly how a second, unrelated
install once silently recreated a first install's live containers in place, reattaching its
Postgres volume under freshly generated secrets that didn't match what was already stored there.
The pre-1.0 fallback baked into the compose file (`brainstand`, with no `COMPOSE_PROJECT_NAME` set)
is left as-is on purpose: every deployment from before this behavior already has volumes named
`brainstand_*`, and changing that fallback would make Compose treat them as a new, empty project on
their next `up`.

## When preflight refuses

Preflight prints one line per refusal and exits with that check's code. Nothing has been written when it exits, so fix the cause and re-run.

**Exit 10 — Docker is missing or its daemon is unreachable.**
```text
PREFLIGHT: Docker is not installed; install Docker Engine 24+ (or Docker Desktop) and re-run.
PREFLIGHT: the Docker daemon is unreachable; start Docker (or Docker Desktop) and re-run.
```
Install Docker, or start it. On a server, confirm your user can talk to the daemon (`docker info`).

**Exit 11 — Docker Compose is older than v2.20.**
```text
PREFLIGHT: Docker Compose 1.29.2 is too old; Mobrain needs v2.20 or newer — upgrade the Compose plugin and re-run.
PREFLIGHT: could not determine the Docker Compose version; install the Compose v2 plugin (floor v2.20) and re-run.
```
Install or upgrade the Compose **v2 plugin** (`docker compose version`, not the legacy `docker-compose` v1 binary).

**Exit 12 — host memory is below 4096 MB.**
```text
PREFLIGHT: Mobrain needs at least 4096 MB of memory; this host reports 1024 MB — add RAM or move to a larger host before installing.
```
Add RAM or move to a larger host. (If the host cannot be measured at all, preflight warns and skips the check rather than refusing.)

**Exit 13 — free space on the Docker data root is below 20 GB.**
```text
PREFLIGHT: Mobrain needs at least 20 GB free on the Docker data root; this host reports 5 GB — free space before installing.
```
Free space where Docker stores images and volumes (`docker info` reports `DockerRootDir`). On Docker Desktop for Windows/macOS that path is inside the VM, so preflight falls back to the host filesystem.

**Exit 17 — `COMPOSE_PROJECT_NAME` already has containers on this host.**
```text
PREFLIGHT: a Compose project named 'brainstand' already has containers on this host (brainstand-caddy-1 brainstand-postgres-1 ...); installing here would recreate them in place with THIS install's freshly generated secrets, likely breaking whatever is already using them. Choose a different COMPOSE_PROJECT_NAME, or remove that project first if it's really yours to replace.
```
Either this is genuinely a second install (pick a different, unique `COMPOSE_PROJECT_NAME`, or unset it and let the installer derive one — see above), or the named project really is meant to be replaced (stop and remove it deliberately first, outside the installer).

**Exit 14 — port 80 or 443 is already in use.**
```text
PREFLIGHT: port 443 is already in use; stop the process or container bound to 443 before installing.
```
Stop whatever holds the port. A port held by a container of *this* Compose project (for example, an already-running Mobrain stack) is not treated as a conflict.

**Exit 15 — `DOMAIN` does not resolve to this host.**
```text
PREFLIGHT: DOMAIN nx.invalid does not resolve to this host; point its A/AAAA record here before installing.
```
Point the domain's DNS at this host first; Caddy needs it for the ACME challenge. For a private-network install with no public DNS, see "Private-network install (no public DNS)" below — `PREFLIGHT_SKIP_DNS=1` alone only silences this check, it does not change how Caddy gets a certificate.

**Exit 16 — the pinned images cannot be pulled.**
```text
PREFLIGHT: the pinned Mobrain images cannot be pulled; check ghcr.io/molioros credentials, or build them locally with 'docker compose -f compose/docker-compose.yml -f compose/docker-compose.build.yml build'.
```
The installer reports the same failure after its own pull attempt (`Could not pull the pinned Mobrain images.`). The registry is unreachable, or your credentials lack access. See the next section.

`SKIP_PREFLIGHT=1` skips the whole preflight — do not use it in production; it exists so installer unit tests can exercise the secret-generation path without a live daemon.

## Air-gapped or registry-less hosts

The production Compose file pulls published images and has no `build:` stanza. If you cannot pull from `ghcr.io/molioros`, build the same three images locally from the source checkout with the build overlay, then bring the stack up:

```bash
docker compose --env-file .env -f compose/docker-compose.yml -f compose/docker-compose.build.yml build
docker compose --env-file .env -f compose/docker-compose.yml up -d --wait
```

This is a documented fallback, not the default path: it needs the source tree, the toolchains and the build time. The build overlay (`compose/docker-compose.build.yml`) is the only place build stanzas live; the production file must never gain one.

## Private-network install (no public DNS)

> If you have no domain at all, you want **local mode** — leave the domain prompt blank (or set `INSTALL_MODE=local`) and the installer does all of this for you against the host's LAN address. This section is for the different case: you *have* an internal hostname (`brain.internal.acme-co.lan`) that only resolves on your own network.

By default (`MOBRAIN_TLS_MODE=public`, unset is the same thing) Caddy requests a real certificate from Let's Encrypt for `DOMAIN`, which needs that domain publicly resolvable and reachable on 80/443 for the ACME HTTP-01 challenge. That's not possible for a brain that only lives on an internal network.

For that case, set `MOBRAIN_TLS_MODE=internal`:

```bash
MOBRAIN_TLS_MODE=internal DOMAIN=brain.internal.acme-co.lan bash scripts/install.sh
```

This does two things: it tells `compose/Caddyfile`'s main site to issue from Caddy's own local CA (`tls internal`) instead of attempting public ACME, and it makes preflight treat the DNS check as satisfied — the same effect as `PREFLIGHT_SKIP_DNS=1`, but explained in terms of the mode that's actually active rather than a bare skip. `INSTALL_MODE=local` skips that same check for the same reason — there is no public name to resolve — and its warning names the active mode.

**The tradeoff is real, not cosmetic.** Caddy's local CA is self-signed and known to nobody but this Caddy instance. Every browser and API client that talks to `https://<DOMAIN>` will show an untrusted-certificate warning (or fail closed, for a client that doesn't let you click through) until you separately distribute that CA's root certificate and have each client trust it. `PREFLIGHT_SKIP_DNS=1` on its own does none of this — it only silences preflight's DNS check, leaving Caddy still attempting (and endlessly failing) public ACME, so the stack reports healthy via `docker compose --wait` while HTTPS never actually works and the browser-only first-admin step has nothing to load. Use `MOBRAIN_TLS_MODE=internal`, not a bare DNS skip, for a real private-network install.

## Create the first admin

In domain mode:

```text
Stack is up. Open https://<DOMAIN> and create your first admin.
```

In local mode:

```text
Stack is up. Open https://<lan-ip> from any device on your network and create
your first admin.

Your browser will warn about the certificate the first time — that's expected,
it's a private local CA, not a mistake. See docs/runbooks/install.md.
```

In local mode that address works from the host itself and from any phone, tablet or laptop on the same network. The certificate warning appears once per device and per browser; clicking through is expected. To remove it, distribute Caddy's local CA root and trust it on each device — the same tradeoff described under [Private-network install](#private-network-install-no-public-dns).

Open `https://<DOMAIN>`. A box with no admin shows the bootstrap form; create the first admin (owner). That account can then add members, Connections, and the org's provider API keys. A returning operator sees the sign-in page instead.

### Google sign-in (optional)

You can skip this entirely. It adds a **"Continue with Google"** button next to the email/password form, a second way in, not a replacement. Everything above works the same with or without it, and a deployment that leaves it unset behaves exactly as before.

To turn it on:

1. In the Google Cloud Console, open **APIs & Services → Credentials**, and create an **OAuth client ID** of type **Web application**.
2. Under **Authorized redirect URIs**, add exactly `https://<DOMAIN>/api/auth/callback/google`, using the same `DOMAIN` the installer wrote to `.env`. Google only accepts a real hostname here, not a bare LAN IP address, so this is for domain mode.
3. Give the resulting Client ID and Client Secret to the installer: answer its optional *"Google OAuth Client ID (leave blank to skip):"* prompt, or set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment before you run it. On an existing install, set `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=` in `.env` (add the lines if an older `.env` lacks them) and run `docker compose up -d` again.

Google is only enabled when both values are set. If either is empty, no Google provider is registered and no button appears. A non-interactive install (`INSTALL_MODE` set) never asks and skips Google unless you pass the two variables.

Verify the stack before you go further:

```bash
curl -sk https://<DOMAIN>/api/health
```

A healthy fresh install answers `200` with `pin.matches: true`, `components.controlDb: "ok"`, `components.ops: "ok"`, and `runner.state: "disabled"` (because you did not enable the runner).

Note that `https://<DOMAIN>/admin` is deliberately **not** routed: it answers `404`. gbrain's embedded admin SPA is a second control plane with god rights over the same brain. The recovery path is [`break-glass.md`](break-glass.md).

## Where the secrets live

The installer generates four distinct secrets and writes them to the env file at `$ENV_PATH` — by default the repository-root `.env`, mode `600`:

| Variable | Used by |
|---|---|
| `POSTGRES_PASSWORD` | the database |
| `OPS_RPC_TOKEN` | control plane ↔ `gbrain-ops` RPC |
| `ENCRYPTION_KEY` | the KEK for every sealed secret in the control DB |
| `BETTER_AUTH_SECRET` | console sessions |

`RUNNER_TOKEN` is written empty (runner off) or generated (runner on). Provider API keys such as `anthropic_api_key` and `openai_api_key` are **not** in `.env`; they are added later from the console and stored envelope-encrypted, under `ENCRYPTION_KEY`, in the control DB's `secrets` table. To use a different env file, set `MOBRAIN_ENV_PATH` (the legacy `BRAINSTAND_ENV_PATH` also works for one release) before running the installer.

Never commit `.env`. It holds the keys to everything else.

## The first thing to do after install

**Back up `ENCRYPTION_KEY` somewhere that is not the backup archive.** Copy it out of `.env` now and store it in the secret manager or password manager your team already uses. The backup lane stores an *encrypted* `secrets-*.sql` dump in every archive; that dump is useless without this key, and this key is useless without that dump — so keeping the two together turns a leaked archive into a credential dump. The backup manifest warns about exactly this on every run.

Losing `ENCRYPTION_KEY` makes every stored secret unrecoverable. There is no recovery path.

## Next

- Take a first verified backup: [`backup-restore.md`](backup-restore.md).
- Connect members' agents, then add schedules: [`scheduler.md`](scheduler.md).
- If and only if you want model-written code running against your brain, enable the runner and read its runbook first: [`agent-runner.md`](agent-runner.md).
- Before you upgrade: [`upgrade.md`](upgrade.md), and the [support policy](../support-policy.md) for which version is supported.
