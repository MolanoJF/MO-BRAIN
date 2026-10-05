# Mobrain

**Mobrain is a self-hosted company brain.** It wraps [gbrain](https://github.com/garrytan/gbrain) — the CLI/MCP knowledge system — in a stack a team deploys on one host with a single command and then operates from a web console. Your people and your agents ask questions of a shared, permissioned corpus; admins manage members, Connections, sources, schedules, spend and upgrades from the console. The brain itself is gbrain's, pinned and upgraded, never forked.

- **One host.** Docker Compose, one brain per deployment. No Kubernetes.
- **gbrain stays upstream.** It is a pinned dependency driven only through its published contracts, never a vendored or patched copy.
- **The console is the product.** Its API is `/api/*`; gbrain's own `/admin` is deliberately not exposed.

## Install

Mobrain is deployed from a checkout of this repository, on the host that will run it. From the repository root:

```bash
bash scripts/install.sh
```

It asks one question. **Leave the domain blank** and Mobrain installs for this machine only: it detects the host's LAN address, issues a certificate from Caddy's own local CA, and the brain is reachable at `https://<lan-ip>` from any device on your network. Your browser warns about that certificate once — it is a private CA, not a broken install.

**Answer with a domain** you control and you get today's public path instead: Caddy obtains a real Let's Encrypt certificate, which needs that domain's A/AAAA record already pointing at this host.

```bash
DOMAIN=brain.acme-co.com bash scripts/install.sh
```

Either way the one command runs the preflight below, asks whether to enable the optional agent runner, generates the four secrets into a `.env`, pulls the pinned images, and brings the stack up with `docker compose up -d --wait`. When it finishes, open the URL it prints and create the first admin.

The images are registry-qualified and exactly pinned:

```text
${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molioros}/gbrain-base:0.50.5.0
${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molioros}/control-plane:${APP_VERSION:-1.0.0}
${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molioros}/agent-runner:2.1.274   # only with the runner
```

`IMAGE_REGISTRY` defaults to `ghcr.io` and `IMAGE_NAMESPACE` defaults to `molioros` (the product is **Mobrain**; GHCR images publish under the MoliorOS org namespace that owns the release). Both are plain environment variables, so an operator running their own registry sets them explicitly:

```bash
DOMAIN=brain.acme-co.com IMAGE_REGISTRY=ghcr.io IMAGE_NAMESPACE=molioros bash scripts/install.sh
```

Never use a moving tag. The gbrain and harness versions are exact, and the production compose file pulls images — it never builds them. On an air-gapped or registry-less host, `scripts/install.sh` names the documented local-build fallback when the pull fails (see [`docs/runbooks/install.md`](docs/runbooks/install.md)).

### What preflight enforces

`scripts/preflight.sh` runs before the installer generates a single secret. It refuses to continue, with one exit code per reason, unless:

| Requirement | Floor |
|---|---|
| Docker Engine (or Docker Desktop) with a reachable daemon | installed and running |
| Docker Compose plugin | **v2.20** |
| Host memory | **4096 MB** |
| Free space on the Docker data root | **20 GB** |
| Compose project name | not already running containers on this host |
| TCP ports 80 and 443 | free (a port held by this stack is not a conflict) |
| `DOMAIN` (domain mode only) | resolves to one of this host's addresses — not checked in local mode, which has no public name |
| The pinned images | pullable (`ghcr.io/molioros/...`) |

`scripts/install.sh` picks a `COMPOSE_PROJECT_NAME` for you if you don't set one — deterministically, from the checkout's own path, so two unrelated checkouts on the same host never collide by default. See [`docs/runbooks/install.md`](docs/runbooks/install.md#compose-project-name) for why that matters and how to pin one yourself.

Each refusal prints exactly one line saying what to do; the codes are listed in the [install runbook](docs/runbooks/install.md).

## The agent runner is optional, and off by default

The installer asks one question, in these words:

> This container runs model-written code against your brain, using your organization's API key, on a schedule, with nobody watching. Enable it? [y/N]:

Anything other than an explicit **yes** leaves it off. When off, the runner is a Compose profile that a plain install never starts, `RUNNER_TOKEN` is empty, and `/api/health` reports `runner.state: "disabled"`. A deployment that only connects members' own agents never enables it.

When on, the runner is fenced to one internal network with no route out and its tool surface is MCP-only — no Bash, no database URL, no `GBRAIN_HOME`, no provider key, no volume mounts. That is the design; read [`docs/runbooks/agent-runner.md`](docs/runbooks/agent-runner.md) before you turn it on.

## Pinned versions

| Dependency | Pin | Where |
|---|---|---|
| gbrain | **0.50.5.0** | `GBRAIN_VERSION`, build `ARG GBRAIN_VERSION` ([upstream](https://github.com/garrytan/gbrain)) |
| Mobrain app (control plane) | **1.0.0** | `APP_VERSION` (the `control-plane` image tag) |
| Claude Code harness (agent runner only) | **2.1.274** | `HARNESS_VERSION` |

Exact semver, never `latest` or `latest-stable`. The contract suite runs on demand via `stack.yml` — including before every release, since `release.yml` calls it — against the pinned version or a pinned-next candidate; the [support policy](docs/support-policy.md) says what that buys you.

## Built on gbrain

Mobrain is **not a fork** of gbrain and does not vendor its source. It pins gbrain as an upstream dependency and drives it through the contracts gbrain publishes — its CLI (argv arrays, never shell strings), its HTTP MCP data lane, and a small file plane for what `config set` refuses. If you want gbrain itself, without the console or the deployment, go to [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain).

gbrain is MIT-licensed. Its copyright and licence text are reproduced here because "built on gbrain" is a claim about someone else's active project and the MIT terms require the notice to travel with the work:

```text
MIT License

Copyright (c) 2026 Garry Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Mobrain's own licence is [MIT](LICENSE).

## What this is not

- **Not a fork of gbrain.** No patches, no imports past its `exports` map, no direct table reads. Anything we need beyond the contracts is an upstream contribution, not a local edit.
- **Not a replacement for gbrain's `/admin`.** gbrain ships an embedded admin SPA with god rights over the same brain; exposing it would be a second, unaudited control plane. Mobrain answers `404` for it and documents an SSH break-glass path instead ([`docs/runbooks/break-glass.md`](docs/runbooks/break-glass.md)).
- **Not multi-tenant.** One brain per deployment. gbrain is single-brain-per-`GBRAIN_HOME`; Space-level read isolation (`source_id` / `federated_read`) is the only isolation axis. A shared deployment with several organizations is not a supported shape.
- **Not a managed service.** This is the self-host product. There is no signup, no billing, and no provisioner in this release.

## Docs

| | |
|---|---|
| [Install runbook](docs/runbooks/install.md) | First install, every preflight refusal, the air-gapped build, the first admin, the secrets |
| [Upgrade runbook](docs/runbooks/upgrade.md) | The one host command, snapshots, and one-command rollback |
| [Backup and restore](docs/runbooks/backup-restore.md) | Taking a verified backup and restoring it (including to a new domain) |
| [Agent runner](docs/runbooks/agent-runner.md) | Enable/disable, health states, "what did the 3am agent do", reverting a run |
| [Scheduler](docs/runbooks/scheduler.md) | Writing, pausing and diagnosing scheduled jobs |
| [Break-glass](docs/runbooks/break-glass.md) | Operating the brain when the console is down |
| [Security policy](SECURITY.md) | Reporting a vulnerability, and the trust boundaries |
| [Support policy](docs/support-policy.md) | Which gbrain version is supported, and how upgrades land |

## Licence

[MIT](LICENSE) for Mobrain. gbrain is MIT, Copyright (c) 2026 Garry Tan; see [Built on gbrain](#built-on-gbrain).
